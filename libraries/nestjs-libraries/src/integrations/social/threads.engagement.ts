import {
  CommentPageQuery,
  EngagementError,
  SocialEngagement,
} from './social.engagement';

const GRAPH = 'https://graph.threads.net/v1.0';
const COMMENT_FIELDS =
  'id,text,username,permalink,timestamp,media_type,media_url,has_replies,root_post,replied_to,is_reply,is_reply_owned_by_me,hide_status';
const objectId = (value: string | { id?: string } | undefined) =>
  typeof value === 'string' ? value : value?.id;

/** Same Graph operations as KOLab-Threads-Backend, with bounded, read-only pagination. */
export class ThreadsEngagement implements SocialEngagement {
  constructor(
    private readonly request: typeof fetch = (...args) => fetch(...args),
    private readonly pause: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  private id(id: string) {
    if (!/^\d+$/.test(id))
      throw new EngagementError('Expected a numeric Threads platform ID.', 400);
    return id;
  }

  private async graph(
    token: string,
    path: string,
    params: Record<string, string> = {},
    method = 'GET'
  ): Promise<any> {
    const query = new URLSearchParams(params);
    let response: Response;
    try {
      response = await this.request(
        `${GRAPH}/${path}${method === 'GET' ? `?${query}` : ''}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(method === 'POST'
              ? { 'Content-Type': 'application/x-www-form-urlencoded' }
              : {}),
          },
          ...(method === 'POST' ? { body: query.toString() } : {}),
          signal: AbortSignal.timeout(15000),
        }
      );
    } catch {
      throw new EngagementError(
        'Threads request failed or timed out. Check the post before retrying a write.'
      );
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.error) {
      const code = result?.error?.code;
      if (code === 190 || response.status === 401) {
        throw new EngagementError(
          'Threads access token expired. Reconnect the channel if refreshing fails.',
          401,
          true
        );
      }
      if ([10, 200].includes(code) || response.status === 403) {
        throw new EngagementError(
          'Threads denied this operation. Check ownership and reconnect with the required reply, insights, or delete permissions.',
          403
        );
      }
      if (response.status === 429 || [4, 32, 613].includes(code)) {
        throw new EngagementError(
          'Threads rate limit reached. Retry later.',
          429
        );
      }
      // Do not return Graph URLs, raw errors, or tokens to API consumers.
      throw new EngagementError(
        `Threads rejected the request${
          typeof code === 'number' ? ` (code ${code})` : ''
        }.`,
        response.status === 400 ? 400 : 502
      );
    }
    return result;
  }

  async assertOwnedPost(token: string, accountId: string, postId: string) {
    const post = await this.graph(token, this.id(postId), {
      fields: 'id,owner',
    });
    if (objectId(post.owner) !== accountId) {
      throw new EngagementError(
        'The post does not belong to this connected Threads account.',
        403
      );
    }
  }

  async postAnalytics(token: string, postId: string) {
    const result = await this.graph(token, `${this.id(postId)}/insights`, {
      metric: 'views,likes,replies,reposts,quotes,shares',
    });
    if (!Array.isArray(result.data))
      throw new EngagementError(
        'Threads returned an invalid insights response.'
      );
    return { postId, period: 'lifetime', data: result.data };
  }

  async accountInsights(
    token: string,
    accountId: string,
    since: number,
    until: number
  ) {
    const result = await this.graph(
      token,
      `${this.id(accountId)}/threads_insights`,
      {
        metric: 'views,likes,replies,reposts,quotes',
        period: 'day',
        since: String(since),
        until: String(until),
      }
    );
    if (!Array.isArray(result.data))
      throw new EngagementError(
        'Threads returned an invalid account insights response.'
      );
    return result.data;
  }

  async listComments(
    token: string,
    postId: string,
    query: CommentPageQuery = {}
  ) {
    const result = await this.graph(token, `${this.id(postId)}/conversation`, {
      fields: COMMENT_FIELDS,
      limit: String(query.limit ?? 50),
      ...(query.after ? { after: query.after } : {}),
    });
    if (!Array.isArray(result.data))
      throw new EngagementError(
        'Threads returned an invalid replies response.'
      );
    // Graph paging URLs may contain access tokens. Return only an opaque cursor.
    const after = result.paging?.next
      ? result.paging?.cursors?.after
      : undefined;
    if (result.paging?.next && typeof after !== 'string') {
      throw new EngagementError(
        'Threads returned a next page without a pagination cursor.'
      );
    }
    return {
      data: result.data,
      paging: { hasNext: !!after, ...(after ? { after } : {}) },
    };
  }

  private async comment(token: string, postId: string, commentId: string) {
    const comment = await this.graph(token, this.id(commentId), {
      fields: 'id,root_post,replied_to,is_reply,is_reply_owned_by_me',
    });
    if (
      !comment.is_reply ||
      (objectId(comment.root_post) !== postId &&
        objectId(comment.replied_to) !== postId)
    ) {
      throw new EngagementError(
        'This reply does not belong to the requested post.',
        403
      );
    }
    return comment;
  }

  async reply(
    token: string,
    accountId: string,
    postId: string,
    text: string,
    commentId?: string
  ) {
    if (!text.trim() || Array.from(text).length > 500)
      throw new EngagementError(
        'Reply text must contain 1–500 characters.',
        400
      );
    if (commentId) await this.comment(token, postId, commentId);
    const container = await this.graph(
      token,
      `${this.id(accountId)}/threads`,
      {
        media_type: 'TEXT',
        text,
        reply_to_id: this.id(commentId || postId),
      },
      'POST'
    );
    if (!container.id)
      throw new EngagementError('Threads did not return a reply container ID.');
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await this.graph(token, this.id(container.id), {
        fields: 'status',
      });
      if (status.status === 'FINISHED') {
        // Never automatically retry a publish on a network or transient error.
        const published = await this.graph(
          token,
          `${this.id(accountId)}/threads_publish`,
          { creation_id: container.id },
          'POST'
        );
        if (!published.id)
          throw new EngagementError(
            'Threads did not return a published reply ID. Check the post before retrying.'
          );
        return { id: published.id, postId, repliedTo: commentId || postId };
      }
      if (['ERROR', 'EXPIRED'].includes(status.status))
        throw new EngagementError(
          'Threads could not prepare the reply container.',
          400
        );
      await this.pause(1000);
    }
    throw new EngagementError(
      'Threads reply container is still processing; it has not been published.',
      504
    );
  }

  async setCommentHidden(
    token: string,
    postId: string,
    commentId: string,
    hide: boolean
  ) {
    const comment = await this.comment(token, postId, commentId);
    if (objectId(comment.replied_to) !== postId) {
      throw new EngagementError(
        'Threads only supports hiding top-level replies.',
        400
      );
    }
    const result = await this.graph(
      token,
      `${this.id(commentId)}/manage_reply`,
      { hide: String(hide) },
      'POST'
    );
    if (result.success !== true)
      throw new EngagementError(
        'Threads did not confirm the visibility change.'
      );
    return { success: true, commentId, hidden: hide };
  }

  async deleteComment(token: string, postId: string, commentId: string) {
    const comment = await this.comment(token, postId, commentId);
    if (comment.is_reply_owned_by_me !== true) {
      throw new EngagementError(
        'Only the connected account’s own replies can be deleted. Hide audience replies instead.',
        403
      );
    }
    const result = await this.graph(token, this.id(commentId), {}, 'DELETE');
    if (result.success !== true)
      throw new EngagementError('Threads did not confirm reply deletion.');
    return { success: true, commentId };
  }
}
