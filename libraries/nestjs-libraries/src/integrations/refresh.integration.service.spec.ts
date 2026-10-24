import 'reflect-metadata';
import { RefreshIntegrationService } from './refresh.integration.service';

jest.mock('./integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);

function setup() {
  const provider = { refreshToken: jest.fn().mockRejectedValue(new Error('expired')) };
  const manager = { getSocialIntegration: jest.fn().mockReturnValue(provider) };
  const integrations = {
    createOrUpdateIntegration: jest.fn(),
    refreshNeeded: jest.fn(),
    informAboutRefreshError: jest.fn(),
    disconnectChannel: jest.fn(),
  };
  const record = {
    id: 'channel',
    organizationId: 'org',
    providerIdentifier: 'instagram-standalone',
    refreshToken: 'expired-token',
  };
  const service = new RefreshIntegrationService(manager as any, integrations as any);
  return { service, provider, integrations, record };
}

describe('safe token refresh for DM reads', () => {
  it('preserves the publishing channel when a DM refresh fails', async () => {
    const ctx = setup();
    await expect(ctx.service.refresh(ctx.record as any, { disconnectOnFailure: false }))
      .resolves.toBe(false);
    expect(ctx.provider.refreshToken).toHaveBeenCalledWith('expired-token');
    expect(ctx.integrations.refreshNeeded).not.toHaveBeenCalled();
    expect(ctx.integrations.informAboutRefreshError).not.toHaveBeenCalled();
    expect(ctx.integrations.disconnectChannel).not.toHaveBeenCalled();
    expect(ctx.integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('keeps the existing failure behavior for other refresh callers', async () => {
    const ctx = setup();
    await expect(ctx.service.refresh(ctx.record as any)).resolves.toBe(false);
    expect(ctx.integrations.refreshNeeded).toHaveBeenCalledWith('org', 'channel');
    expect(ctx.integrations.disconnectChannel).toHaveBeenCalledWith('org', ctx.record);
  });

  it('does not persist an incomplete token returned by the provider', async () => {
    const ctx = setup();
    ctx.provider.refreshToken.mockResolvedValue({ accessToken: undefined });
    await expect(ctx.service.refresh(ctx.record as any, { disconnectOnFailure: false }))
      .resolves.toBe(false);
    expect(ctx.integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
    expect(ctx.integrations.disconnectChannel).not.toHaveBeenCalled();
  });
});
