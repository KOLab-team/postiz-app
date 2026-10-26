import 'reflect-metadata';
import { PublicInstagramDmService } from './public.instagram-dm.service';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);

function setup(providerIdentifier = 'instagram-standalone') {
  const integration = {
    id: 'channel',
    internalId: '200',
    organizationId: 'org',
    type: 'social',
    providerIdentifier,
    token: 'secret-token',
    tokenExpiration: null,
    disabled: false,
    deletedAt: null,
    inBetweenSteps: false,
  };
  const integrations = {
    getIntegrationById: jest.fn().mockResolvedValue(integration),
  };
  const refresh = { refresh: jest.fn().mockResolvedValue({ accessToken: 'new-token' }) };
  const service = new PublicInstagramDmService(integrations as any, refresh as any);
  const fetchMock = jest.fn();
  global.fetch = fetchMock as any;
  const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  return { service, integration, integrations, refresh, fetchMock, json };
}

describe('Instagram DM public API service', () => {
  it('uses the organization-scoped integration and never calls Meta for a missing channel', async () => {
    const ctx = setup();
    ctx.integrations.getIntegrationById.mockResolvedValue(null);
    await expect(ctx.service.conversations('other-org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({ status: 404 });
    expect(ctx.integrations.getIntegrationById).toHaveBeenCalledWith('other-org', 'channel');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it('lists DMs using only the connected account token and returns an opaque cursor', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({
      data: [{ id: '123', updated_time: '2026-01-01T00:00:00Z' }],
      paging: { cursors: { after: 'next-cursor' }, next: 'https://graph.instagram.com/...' },
    }));
    await expect(ctx.service.conversations('org', 'channel', { limit: 10 }))
      .resolves.toEqual({
        integrationId: 'channel',
        data: [{ id: '123', updated_time: '2026-01-01T00:00:00Z' }],
        paging: { after: 'next-cursor' },
      });
    const [url, options] = ctx.fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v25.0/200/conversations');
    expect(String(url)).toContain('limit=10');
    expect(String(url)).not.toContain('platform=');
    expect(String(url)).not.toContain('secret-token');
    expect(options.headers.Authorization).toBe('Bearer secret-token');
  });

  it('refuses messages when the conversation does not include the connected account', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: '999' }] } }));
    await expect(ctx.service.messages('org', 'channel', '123', { limit: 20 }))
      .rejects.toMatchObject({ status: 404 });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads only a verified conversation and does not follow Meta paging URLs', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'self-scoped' }] } }))
      .mockResolvedValueOnce(ctx.json({ data: [{ id: '456', message: 'Hello', attachments: { data: [{ type: 'image' }] } }] }));
    await expect(ctx.service.messages('org', 'channel', '123', { limit: 20, after: 'cursor' }))
      .resolves.toMatchObject({ data: [{ id: '456', message: 'Hello', attachments: { data: [{ type: 'image' }] } }] });
    expect(String(ctx.fetchMock.mock.calls[2][0])).toContain('/123/messages?');
    expect(String(ctx.fetchMock.mock.calls[2][0])).toContain('after=cursor');
  });

  it('reads a prefixed Page conversation ID returned by the list endpoint', async () => {
    const ctx = setup('instagram');
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'page', instagram_business_account: { id: '200' } }))
      .mockResolvedValueOnce(ctx.json({ data: [{ id: 't_123' }] }))
      .mockResolvedValueOnce(ctx.json({ id: 'page', instagram_business_account: { id: '200' } }))
      .mockResolvedValueOnce(ctx.json({ id: 't_123', participants: { data: [{ id: '200' }] } }))
      .mockResolvedValueOnce(ctx.json({ data: [{ id: 'message-1', message: 'Hello' }] }));
    const listed = await ctx.service.conversations('org', 'channel', { limit: 20 });
    const conversationId = listed.data[0].id;
    const messages = await ctx.service.messages('org', 'channel', conversationId, { limit: 20 });
    expect(messages).toMatchObject({ conversationId: 't_123', data: [{ message: 'Hello' }] });
    expect(String(ctx.fetchMock.mock.calls[1][0])).toContain('platform=instagram');
    expect(String(ctx.fetchMock.mock.calls[3][0])).toContain('/t_123?');
    expect(String(ctx.fetchMock.mock.calls[4][0])).toContain('/t_123/messages?');
  });

  it('rejects path separators in conversation IDs before calling Meta', async () => {
    const ctx = setup();
    await expect(ctx.service.messages('org', 'channel', 't_../other', { limit: 20 }))
      .rejects.toMatchObject({ status: 400 });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it('checks that a Facebook Page token belongs to the connected Instagram account', async () => {
    const ctx = setup('instagram');
    ctx.fetchMock.mockResolvedValue(ctx.json({
      id: 'page', instagram_business_account: { id: 'different-account' },
    }));
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({ status: 403 });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps permission failures to a safe reconnect message without leaking Meta errors', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({
      error: { code: 200, message: 'access_token=secret-token' },
    }, 400));
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('refreshes an expired Instagram Login token once before reading', async () => {
    const ctx = setup();
    ctx.integration.tokenExpiration = new Date(0) as any;
    ctx.fetchMock.mockResolvedValue(ctx.json({ data: [] }));
    await ctx.service.conversations('org', 'channel', { limit: 20 });
    expect(ctx.refresh.refresh).toHaveBeenCalledWith(ctx.integration, {
      disconnectOnFailure: false,
    });
    expect(ctx.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer new-token');
  });

  it('returns an authorization error without reading when safe refresh fails', async () => {
    const ctx = setup();
    ctx.integration.tokenExpiration = new Date(0) as any;
    ctx.refresh.refresh.mockResolvedValue(false);
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({ status: 401 });
    expect(ctx.refresh.refresh).toHaveBeenCalledWith(ctx.integration, {
      disconnectOnFailure: false,
    });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the channel when Meta returns 401 and retry refresh fails', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({ error: { code: 190 } }, 401));
    ctx.refresh.refresh.mockResolvedValue(false);
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({ status: 401 });
    expect(ctx.refresh.refresh).toHaveBeenCalledWith(ctx.integration, {
      disconnectOnFailure: false,
    });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
});
