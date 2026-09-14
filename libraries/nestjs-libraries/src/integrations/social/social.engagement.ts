export interface CommentPageQuery {
  after?: string;
  limit?: number;
}

/** Audience engagement on published platform posts, separate from review notes. */
export interface SocialEngagement {
  assertOwnedPost(
    token: string,
    accountId: string,
    postId: string
  ): Promise<void>;
  postAnalytics(token: string, postId: string): Promise<unknown>;
  listComments(
    token: string,
    postId: string,
    query: CommentPageQuery
  ): Promise<unknown>;
  reply(
    token: string,
    accountId: string,
    postId: string,
    text: string,
    commentId?: string
  ): Promise<unknown>;
  setCommentHidden(
    token: string,
    postId: string,
    commentId: string,
    hide: boolean
  ): Promise<unknown>;
  deleteComment(
    token: string,
    postId: string,
    commentId: string
  ): Promise<unknown>;
}

/** Contains only a sanitized public message, never a provider URL or token. */
export class EngagementError extends Error {
  constructor(
    message: string,
    public status = 502,
    public expiredToken = false
  ) {
    super(message);
  }
}
