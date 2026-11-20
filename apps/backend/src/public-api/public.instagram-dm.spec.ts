import 'reflect-metadata';
import { PublicInstagramDmService } from './public.instagram-dm.service';
import { ValidationPipe } from '@nestjs/common';
import { InstagramDmReplyBody } from './instagram-dm.dto';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);

jest.mock('@gitroom/nestjs-libraries/social-inbox/instagram-dm-health.service', () => ({ InstagramDmHealthService: class {} }));

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
  const health = { reconnectRequired: jest.fn().mockResolvedValue(undefined) };
  const service = new PublicInstagramDmService(integrations as any, refresh as any, health as any);
  const fetchMock = jest.fn();
  global.fetch = fetchMock as any;
  const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  return { service, integration, integrations, refresh, health, fetchMock, json };
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

  it('maps permission failures without claiming a reconnect will fix them', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({
      error: { code: 200, message: 'access_token=secret-token' },
    }, 400));
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({
        status: 403,
        message: 'Meta denied Instagram messaging access. Check the app’s messaging permission and access level.',
      });
  });

  it('identifies a closed reply window without sending a second DM or exposing Meta details', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'self-scoped' }, { id: 'customer' }] } }))
      .mockResolvedValueOnce(ctx.json({
        error: { code: 10, error_subcode: 2534022, message: 'This message is sent outside of allowed window. access_token=secret-token' },
      }, 403));
    await expect(ctx.service.reply('org', 'channel', '123', 'Hello'))
      .rejects.toMatchObject({
        status: 403,
        message: 'Instagram’s API reply window has closed for this conversation. Use the Instagram app if it permits a reply, or wait for the person to message again.',
      });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not label an unclassified Meta 403 as a missing permission', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({ error: { code: 10 } }, 403));
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 }))
      .rejects.toMatchObject({
        status: 403,
        message: 'Meta denied Instagram DM access. Check the app access and connection.',
      });
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

  it('sends a reply only to the other participant of a verified conversation', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'self-scoped' }, { id: 'customer' }] } }))
      .mockResolvedValueOnce(ctx.json({ recipient_id: 'customer', message_id: 'sent-1' }));
    await expect(ctx.service.reply('org', 'channel', '123', 'Thanks!'))
      .resolves.toEqual({ messageId: 'sent-1' });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(3);
    const [url, options] = ctx.fetchMock.mock.calls[2];
    expect(String(url)).toContain('/v25.0/200/messages');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ recipient: { id: 'customer' }, message: { text: 'Thanks!' } });
  });

  it('refuses to send if the conversation belongs to another account', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'other' }, { id: 'customer' }] } }));
    await expect(ctx.service.reply('org', 'channel', '123', 'Hello'))
      .rejects.toMatchObject({ status: 404 });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a send with an uncertain outcome', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'self-scoped' }, { id: 'customer' }] } }))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(ctx.service.reply('org', 'channel', '123', 'Hello'))
      .rejects.toMatchObject({ status: 502 });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(3);
  });
});


describe('Instagram DM reliability regressions', () => {
  const originalFlag = process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED;
  beforeEach(() => { delete process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED; });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED;
    else process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED = originalFlag;
  });
  function verified(ctx: ReturnType<typeof setup>, provider = 'instagram-standalone') {
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json(provider === 'instagram' ? { id: 'page', instagram_business_account: { id: '200' } } : { id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: provider === 'instagram' ? '200' : 'self-scoped' }, { id: 'customer' }] } }));
  }
  it('sends links unchanged with the correct Page response parameter', async () => {
    const ctx = setup('instagram'); verified(ctx, 'instagram');
    ctx.fetchMock.mockResolvedValueOnce(ctx.json({ recipient_id: 'customer', message_id: 'sent-1' }));
    const text = 'Here is the Reel: https://www.instagram.com/reel/example/?x=1&y=2';
    await ctx.service.reply('org', 'channel', '123', text);
    expect(JSON.parse(ctx.fetchMock.mock.calls[2][1].body)).toEqual({ recipient: { id: 'customer' }, message: { text }, messaging_type: 'RESPONSE' });
    expect(ctx.health.reconnectRequired).not.toHaveBeenCalled();
  });
  it('checks UTF-8 bytes before contacting Meta', async () => {
    const ctx = setup();
    await expect(ctx.service.reply('org', 'channel', '123', '好'.repeat(334))).rejects.toMatchObject({ status: 400 });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });
  it('requires app enablement before a human reply', async () => {
    const ctx = setup();
    await expect(ctx.service.replyAsHumanAgent('org', 'channel', '123', 'Hello')).rejects.toMatchObject({ status: 403 });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });
  it.each(['instagram', 'instagram-standalone'])('uses the human tag only for an explicit human reply on %s', async provider => {
    process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED = 'true';
    const ctx = setup(provider); verified(ctx, provider);
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ data: [{ from: { id: 'customer' }, created_time: new Date(Date.now() - 48 * 3600000).toISOString() }] }))
      .mockResolvedValueOnce(ctx.json({ recipient_id: 'customer', message_id: 'sent-1' }));
    await ctx.service.replyAsHumanAgent('org', 'channel', '123', 'Following up on your question');
    const payload = JSON.parse(ctx.fetchMock.mock.calls[3][1].body);
    expect(payload.tag).toBe('HUMAN_AGENT');
    if (provider === 'instagram') expect(payload.messaging_type).toBe('MESSAGE_TAG');
  });
  it.each([null, new Date(Date.now() - 8 * 86400000).toISOString()])('rejects human replies without a verified recent customer message (%s)', async timestamp => {
    process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED = 'true';
    const ctx = setup(); verified(ctx);
    ctx.fetchMock.mockResolvedValueOnce(ctx.json({ data: [{ from: { id: timestamp ? 'customer' : 'self-scoped' }, created_time: timestamp || new Date().toISOString() }] }));
    await expect(ctx.service.replyAsHumanAgent('org', 'channel', '123', 'Hello')).rejects.toMatchObject({ status: 403 });
    expect(ctx.fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0);
  });
  it('alerts on failed token recovery without disconnecting the publishing channel', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValue(ctx.json({ error: { code: 190 } }, 401));
    ctx.refresh.refresh.mockResolvedValue(false);
    await expect(ctx.service.conversations('org', 'channel', { limit: 20 })).rejects.toMatchObject({ status: 401 });
    expect(ctx.health.reconnectRequired).toHaveBeenCalledTimes(1);
    expect(ctx.integration.disabled).toBe(false);
  });
  it('does not alert when safe token refresh recovers access', async () => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValueOnce(ctx.json({ error: { code: 190 } }, 401)).mockResolvedValueOnce(ctx.json({ data: [] }));
    await ctx.service.conversations('org', 'channel', { limit: 20 });
    expect(ctx.health.reconnectRequired).not.toHaveBeenCalled();
  });
  it('alerts if access expires between verification and send, without replaying the send', async () => {
    const ctx = setup(); verified(ctx);
    ctx.fetchMock.mockResolvedValueOnce(ctx.json({ error: { code: 190 } }, 401));
    await expect(ctx.service.reply('org', 'channel', '123', 'Hello')).rejects.toMatchObject({ status: 401 });
    expect(ctx.health.reconnectRequired).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    expect(ctx.refresh.refresh).not.toHaveBeenCalled();
  });
});


describe('Instagram public API boundary', () => {
  it('does not accept the human-only option from an API-key caller', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ text: 'Hello', humanAgent: true }, { type: 'body', metatype: InstagramDmReplyBody })).rejects.toMatchObject({ status: 400 });
  });
  it('keeps rejected links intact and does not replay a send', async () => {
    const ctx = setup();
    ctx.fetchMock
      .mockResolvedValueOnce(ctx.json({ id: 'self-scoped', user_id: '200' }))
      .mockResolvedValueOnce(ctx.json({ id: '123', participants: { data: [{ id: 'self-scoped' }, { id: 'customer' }] } }))
      .mockResolvedValueOnce(ctx.json({ error: { code: 100, message: 'This URL is blocked. access_token=secret-token' } }, 400));
    await expect(ctx.service.reply('org', 'channel', '123', 'https://example.com')).rejects.toMatchObject({ status: 400, message: 'Instagram rejected a link in this reply. Check the URL or share the post from Instagram.' });
    expect(ctx.fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    expect(ctx.health.reconnectRequired).not.toHaveBeenCalled();
  });
});
