import { ThreadsEngagement } from './threads.engagement';
import { EngagementError } from './social.engagement';

function setup(...responses: unknown[]) {
  const request = jest.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  });
  return {
    request,
    api: new ThreadsEngagement(request as any, async () => {}),
  };
}

describe('Threads audience engagement', () => {
  it('checks the actual platform owner and refuses another account’s post', async () => {
    const { api } = setup({ id: '100', owner: { id: '200' } });
    await expect(
      api.assertOwnedPost('token', '201', '100')
    ).rejects.toMatchObject({ status: 403 });
  });

  it('retrieves all six post metrics and uses header authentication', async () => {
    const data = [{ name: 'likes', values: [{ value: 7 }] }];
    const { api, request } = setup({ data });
    await expect(api.postAnalytics('secret', '100')).resolves.toEqual({
      postId: '100',
      period: 'lifetime',
      data,
    });
    const [url, options] = request.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(new URL(url).searchParams.get('metric')).toBe(
      'views,likes,replies,reposts,quotes,shares'
    );
    expect(url).not.toContain('secret');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('paginates the complete conversation without following URLs or hiding replies', async () => {
    const { api, request } = setup({
      data: [{ id: '101', text: 'spam' }],
      paging: {
        next: 'https://graph.threads.net/100/conversation?access_token=secret',
        cursors: { after: 'opaque+/' },
      },
    });
    const result = await api.listComments('secret', '100', {
      limit: 10,
      after: 'previous+/',
    });
    expect(result).toEqual({
      data: [{ id: '101', text: 'spam' }],
      paging: { hasNext: true, after: 'opaque+/' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      new URL((request.mock.calls[0] as any)[0]).searchParams.get('after')
    ).toBe('previous+/');
  });

  it('returns no cursor when there is no next page', async () => {
    const { api } = setup({ data: [], paging: { cursors: { after: 'last' } } });
    await expect(api.listComments('t', '100', {})).resolves.toEqual({
      data: [],
      paging: { hasNext: false },
    });
  });

  it('validates a nested reply’s post, prepares a container, and publishes once', async () => {
    const { api, request } = setup(
      { is_reply: true, root_post: { id: '100' }, replied_to: { id: '102' } },
      { id: '300' },
      { status: 'IN_PROGRESS' },
      { status: 'FINISHED' },
      { id: '400' }
    );
    await expect(
      api.reply('t', '200', '100', 'Thanks & hello 👋', '101')
    ).resolves.toEqual({ id: '400', postId: '100', repliedTo: '101' });
    const [, createOptions] = request.mock.calls[1] as any;
    expect(new URLSearchParams(createOptions.body).get('text')).toBe(
      'Thanks & hello 👋'
    );
    expect(new URLSearchParams(createOptions.body).get('reply_to_id')).toBe(
      '101'
    );
    expect(
      request.mock.calls.filter((call: any) =>
        call[0].includes('threads_publish')
      )
    ).toHaveLength(1);
  });

  it('never publishes a container that times out or errors', async () => {
    const { api, request } = setup(
      { id: '300' },
      ...Array(10).fill({ status: 'IN_PROGRESS' })
    );
    await expect(api.reply('t', '200', '100', 'Hello')).rejects.toMatchObject({
      status: 504,
    });
    expect(
      request.mock.calls.some((call: any) =>
        call[0].includes('threads_publish')
      )
    ).toBe(false);
  });

  it('does not retry an uncertain publish', async () => {
    const { api, request } = setup(
      { id: '300' },
      { status: 'FINISHED' },
      new Error('network token=secret')
    );
    await expect(api.reply('secret', '200', '100', 'Hello')).rejects.toThrow(
      'Check the post before retrying'
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    'sets explicit hide=%s for top-level replies',
    async (hide) => {
      const { api, request } = setup(
        { is_reply: true, replied_to: { id: '100' } },
        { success: true }
      );
      await expect(
        api.setCommentHidden('t', '100', '101', hide)
      ).resolves.toEqual({ success: true, commentId: '101', hidden: hide });
      expect((request.mock.calls[1] as any)[1].body).toBe(`hide=${hide}`);
    }
  );

  it('rejects unrelated and nested comments before a visibility write', async () => {
    for (const comment of [
      { is_reply: true, root_post: { id: '999' }, replied_to: { id: '999' } },
      { is_reply: true, root_post: { id: '100' }, replied_to: { id: '102' } },
    ]) {
      const { api, request } = setup(comment);
      await expect(
        api.setCommentHidden('t', '100', '101', true)
      ).rejects.toBeInstanceOf(EngagementError);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('only deletes replies owned by the connected account', async () => {
    const own = {
      is_reply: true,
      is_reply_owned_by_me: true,
      root_post: { id: '100' },
    };
    const allowed = setup(own, { success: true });
    await expect(allowed.api.deleteComment('t', '100', '101')).resolves.toEqual(
      { success: true, commentId: '101' }
    );
    expect((allowed.request.mock.calls[1] as any)[1].method).toBe('DELETE');
    const denied = setup({ ...own, is_reply_owned_by_me: false });
    await expect(
      denied.api.deleteComment('t', '100', '101')
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 190, 401, true],
    [400, 10, 403, false],
    [429, 4, 429, false],
    [500, 2, 502, false],
  ])(
    'surfaces HTTP %s / Graph code %s without leaking upstream secrets',
    async (httpStatus, code, status, expiredToken) => {
      const { api, request } = setup(
        Response.json(
          { error: { code, message: 'secret-token' } },
          { status: httpStatus as number }
        )
      );
      await expect(
        api.postAnalytics('secret-token', '100')
      ).rejects.toMatchObject({ status, expiredToken });
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects malformed IDs before contacting Graph', async () => {
    const { api, request } = setup();
    await expect(api.postAnalytics('t', '../me')).rejects.toMatchObject({
      status: 400,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
