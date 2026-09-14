import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PublicEngagementService } from './public.engagement.service';
import { PublicEngagementController } from './routes/v1/public.engagement.controller';
import { PublicAuthMiddleware } from '../services/auth/public.auth.middleware';
import { EngagementError } from '@gitroom/nestjs-libraries/integrations/social/social.engagement';

// Isolate database/provider infrastructure; exercise the real service and HTTP controller.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository',
  () => ({ PostsRepository: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  RefreshToken: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service',
  () => ({ OAuthService: class {} })
);
jest.mock('../services/auth/auth.middleware', () => ({
  removeAuth: jest.fn(),
}));

function setup() {
  const api = {
    assertOwnedPost: jest.fn().mockResolvedValue(undefined),
    postAnalytics: jest.fn().mockResolvedValue({
      period: 'lifetime',
      data: [{ name: 'likes', values: [{ value: 5 }] }],
    }),
    listComments: jest
      .fn()
      .mockResolvedValue({ data: [], paging: { hasNext: false } }),
    reply: jest.fn().mockResolvedValue({ id: '777' }),
    setCommentHidden: jest.fn().mockResolvedValue({ success: true }),
    deleteComment: jest.fn().mockResolvedValue({ success: true }),
  };
  const integration = {
    id: 'channel',
    organizationId: 'org',
    internalId: '200',
    token: 'token',
    type: 'social',
    providerIdentifier: 'threads',
    tokenExpiration: null,
  };
  const integrations = {
    getIntegrationById: jest.fn().mockResolvedValue(integration),
  };
  const posts = {
    getPost: jest.fn().mockResolvedValue({
      state: 'PUBLISHED',
      releaseId: '100',
      integrationId: 'channel',
    }),
  };
  const provider = {
    engagement: api,
    analytics: jest.fn().mockResolvedValue([{ label: 'Likes', data: [] }]),
  };
  const providers = {
    getSocialIntegration: jest.fn().mockReturnValue(provider),
  };
  const refresh = {
    refresh: jest.fn().mockResolvedValue({ accessToken: 'refreshed' }),
  };
  const service = new PublicEngagementService(
    integrations as any,
    posts as any,
    providers as any,
    refresh as any
  );
  return { service, api, integration, integrations, posts, provider, refresh };
}

describe('Public engagement service', () => {
  it('returns measured account series without the legacy placeholder percentage', async () => {
    const { service, provider } = setup();
    provider.analytics.mockResolvedValue([
      { label: 'Likes', data: [], percentageChange: 5 },
    ] as any);
    await expect(
      service.accountAnalytics('org', 'channel', 30)
    ).resolves.toEqual([{ label: 'Likes', data: [] }]);
  });

  it('preserves existing main-branch analytics for other providers', async () => {
    const current = setup();
    current.provider.engagement = undefined as any;
    const analytics = jest
      .fn()
      .mockResolvedValue([{ label: 'Views', data: [] }]);
    Object.assign(current.provider, { postAnalytics: analytics });
    await expect(
      current.service.postAnalytics('org', 'postiz-id', {})
    ).resolves.toEqual([{ label: 'Views', data: [] }]);
    expect(analytics).toHaveBeenCalledWith('200', 'token', '100', 30);
    await expect(
      current.service.postAnalytics('org', '100', { integrationId: 'channel' })
    ).rejects.toMatchObject({ status: 501 });
  });

  it('maps a Postiz post to its native ID and scopes both lookups to the organization', async () => {
    const { service, posts, integrations, api } = setup();
    await service.postAnalytics('org', 'postiz-id', {});
    expect(posts.getPost).toHaveBeenCalledWith('postiz-id', false, 'org');
    expect(integrations.getIntegrationById).toHaveBeenCalledWith(
      'org',
      'channel'
    );
    expect(api.assertOwnedPost).toHaveBeenCalledWith('token', '200', '100');
    expect(api.postAnalytics).toHaveBeenCalledWith('token', '100');
  });

  it('allows native IDs for posts created outside Postiz after checking account ownership', async () => {
    const { service, posts, api } = setup();
    await service.postAnalytics('org', '999', { integrationId: 'channel' });
    expect(posts.getPost).not.toHaveBeenCalled();
    expect(api.assertOwnedPost).toHaveBeenCalledWith('token', '200', '999');
  });

  it('never queries Graph for another organization’s post or integration', async () => {
    const missingPost = setup();
    missingPost.posts.getPost.mockResolvedValue(null);
    await expect(
      missingPost.service.postAnalytics('other-org', 'id', {})
    ).rejects.toMatchObject({ status: 404 });
    expect(missingPost.api.postAnalytics).not.toHaveBeenCalled();
    const missingChannel = setup();
    missingChannel.integrations.getIntegrationById.mockResolvedValue(null);
    await expect(
      missingChannel.service.postAnalytics('other-org', '100', {
        integrationId: 'channel',
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(missingChannel.api.assertOwnedPost).not.toHaveBeenCalled();
  });

  it('rejects drafts, disabled channels, deleted channels, and unsupported providers', async () => {
    const draft = setup();
    draft.posts.getPost.mockResolvedValue({ state: 'DRAFT' });
    await expect(
      draft.service.postAnalytics('org', 'id', {})
    ).rejects.toMatchObject({ status: 400 });
    for (const extra of [{ disabled: true }, { deletedAt: new Date() }]) {
      const current = setup();
      Object.assign(current.integration, extra);
      await expect(
        current.service.postAnalytics('org', 'id', {})
      ).rejects.toBeDefined();
      expect(current.api.assertOwnedPost).not.toHaveBeenCalled();
    }
    const unsupported = setup();
    unsupported.provider.engagement = undefined as any;
    await expect(
      unsupported.service.postAnalytics('org', 'id', {})
    ).rejects.toMatchObject({ status: 501 });
  });

  it('refreshes a rejected token once and repeats with the new token', async () => {
    const { service, api, refresh } = setup();
    api.postAnalytics.mockRejectedValueOnce(
      new EngagementError('Expired', 401, true)
    );
    await service.postAnalytics('org', 'id', {});
    expect(refresh.refresh).toHaveBeenCalledTimes(1);
    expect(api.postAnalytics).toHaveBeenLastCalledWith('refreshed', '100');
  });

  it('stops after a failed refresh or a second authorization failure', async () => {
    const current = setup();
    current.api.postAnalytics.mockRejectedValue(
      new EngagementError('Expired', 401, true)
    );
    await expect(
      current.service.postAnalytics('org', 'id', {})
    ).rejects.toMatchObject({ status: 401 });
    expect(current.refresh.refresh).toHaveBeenCalledTimes(1);
    expect(current.api.postAnalytics).toHaveBeenCalledTimes(2);
    const failed = setup();
    failed.api.postAnalytics.mockRejectedValue(
      new EngagementError('Expired', 401, true)
    );
    failed.refresh.refresh.mockResolvedValue(false);
    await expect(
      failed.service.postAnalytics('org', 'id', {})
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refreshes known expired credentials before a write', async () => {
    const { service, integration, api, refresh } = setup();
    integration.tokenExpiration = new Date(0) as any;
    await service.reply('org', 'id', {}, { text: 'Hello' });
    expect(refresh.refresh).toHaveBeenCalledTimes(1);
    expect(api.reply).toHaveBeenCalledWith(
      'refreshed',
      '200',
      '100',
      'Hello',
      undefined
    );
  });

  it('does not replay writes on non-auth failures or expose raw provider errors', async () => {
    const { service, api, refresh } = setup();
    api.reply.mockRejectedValue(
      new Error('https://graph.threads.net?access_token=secret')
    );
    await expect(
      service.reply('org', 'id', {}, { text: 'Hello' })
    ).rejects.toMatchObject({ status: 502 });
    expect(api.reply).toHaveBeenCalledTimes(1);
    expect(refresh.refresh).not.toHaveBeenCalled();
  });
});

describe('Public engagement HTTP API', () => {
  let app: INestApplication;
  let base: string;
  let current: ReturnType<typeof setup>;
  beforeAll(async () => {
    current = setup();
    const module = await Test.createTestingModule({
      controllers: [PublicEngagementController],
      providers: [
        { provide: PublicEngagementService, useValue: current.service },
      ],
    }).compile();
    app = module.createNestApplication();
    const auth = new PublicAuthMiddleware(
      {
        getOrgByApiKey: async (key: string) =>
          key === 'valid-key' ? { id: 'org', subscription: {} } : null,
      } as any,
      {
        getOrgByOAuthToken: async (token: string) =>
          token === 'pos_valid'
            ? { organization: { id: 'org', subscription: {} } }
            : null,
      } as any
    );
    app.use('/public/v1', auth.use.bind(auth));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => jest.clearAllMocks());

  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    key = 'valid-key'
  ) {
    const response = await fetch(`${base}/public/v1${path}`, {
      method,
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  it('requires the raw public API key on reads and writes', async () => {
    expect(
      (await call('/analytics/post/id', 'GET', undefined, '')).status
    ).toBe(401);
    expect(
      (await call('/posts/id/comments', 'POST', { text: 'Hello' }, 'invalid'))
        .status
    ).toBe(401);
    expect(current.api.reply).not.toHaveBeenCalled();
  });

  it('preserves main-branch OAuth token authentication', async () => {
    expect(
      (await call('/analytics/post/id', 'GET', undefined, 'pos_valid')).status
    ).toBe(200);
    expect(
      (await call('/analytics/post/id', 'GET', undefined, 'pos_invalid')).status
    ).toBe(401);
  });

  it('serves both formerly missing analytics routes', async () => {
    expect((await call('/analytics/channel')).status).toBe(200);
    expect(current.provider.analytics).toHaveBeenCalledWith('200', 'token', 30);
    const post = await call('/analytics/post/id');
    expect(post.status).toBe(200);
    expect(post.body.period).toBe('lifetime');
  });

  it('validates dates, pagination, text, and boolean visibility before a provider call', async () => {
    for (const path of [
      '/analytics/channel?date=NaN',
      '/analytics/channel?date=0',
      '/posts/id/comments?limit=101',
      '/posts/id/comments?limit=-1',
    ]) {
      expect((await call(path)).status).toBe(400);
    }
    expect(
      (await call('/posts/id/comments', 'POST', { text: '   ' })).status
    ).toBe(400);
    expect(
      (await call('/posts/id/comments/101/hide', 'PUT', { hide: 'false' }))
        .status
    ).toBe(400);
    expect((await call('/posts/id/comments/101/hide', 'PUT', {})).status).toBe(
      400
    );
    expect(current.api.listComments).not.toHaveBeenCalled();
    expect(current.api.setCommentHidden).not.toHaveBeenCalled();
  });

  it('passes native targeting, cursor pagination, replies, explicit unhide, and deletion', async () => {
    expect(
      (
        await call(
          '/posts/100/comments?integrationId=channel&limit=10&after=next'
        )
      ).status
    ).toBe(200);
    expect(current.api.listComments).toHaveBeenCalledWith(
      'token',
      '100',
      expect.objectContaining({ limit: 10, after: 'next' })
    );
    expect(
      (
        await call('/posts/id/comments', 'POST', {
          text: 'Hello',
          replyToCommentId: '101',
        })
      ).status
    ).toBe(201);
    expect(current.api.reply).toHaveBeenCalledWith(
      'token',
      '200',
      '100',
      'Hello',
      '101'
    );
    expect(
      (await call('/posts/id/comments/101/hide', 'PUT', { hide: false })).status
    ).toBe(200);
    expect(current.api.setCommentHidden).toHaveBeenCalledWith(
      'token',
      '100',
      '101',
      false
    );
    expect((await call('/posts/id/comments/101', 'DELETE')).status).toBe(200);
    expect(current.api.deleteComment).toHaveBeenCalledWith(
      'token',
      '100',
      '101'
    );
  });
});
