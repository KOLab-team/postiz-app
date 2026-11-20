import 'reflect-metadata';
import { InstagramDmHealthService } from './instagram-dm-health.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({
    NotificationService: class {},
  })
);
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(), del: jest.fn() },
}));

describe('Instagram DM reconnection alerts', () => {
  const integration = {
    id: 'channel',
    organizationId: 'org',
    token: 'private-token',
  } as any;
  const keys = new Set<string>();
  let notifications: { inAppNotification: jest.Mock };
  let service: InstagramDmHealthService;

  beforeEach(() => {
    keys.clear();
    jest.clearAllMocks();
    (ioRedis.set as jest.Mock).mockImplementation(async (key: string) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    });
    (ioRedis.del as jest.Mock).mockImplementation(async (key: string) =>
      keys.delete(key)
    );
    notifications = {
      inAppNotification: jest.fn().mockResolvedValue(undefined),
    };
    service = new InstagramDmHealthService(notifications as any);
  });

  it('deduplicates concurrent failures across service instances without recording credentials', async () => {
    await Promise.all([
      service.reconnectRequired(integration),
      new InstagramDmHealthService(notifications as any).reconnectRequired(
        integration
      ),
    ]);
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(1);
    expect(notifications.inAppNotification.mock.calls[0][0]).toBe('org');
    expect(JSON.stringify(ioRedis.set.mock.calls)).not.toContain(
      'private-token'
    );
    expect(ioRedis.set).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      'EX',
      3600,
      'NX'
    );
  });

  it('separates organizations and newly reconnected credentials', async () => {
    await service.reconnectRequired(integration);
    await service.reconnectRequired({
      ...integration,
      organizationId: 'other-org',
    });
    await service.reconnectRequired({
      ...integration,
      token: 'replacement-token',
    });
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(3);
  });

  it('allows a later alert after a notification outage and never replaces the auth failure', async () => {
    notifications.inAppNotification.mockRejectedValueOnce(
      new Error('notification unavailable')
    );
    await expect(
      service.reconnectRequired(integration)
    ).resolves.toBeUndefined();
    await service.reconnectRequired(integration);
    expect(notifications.inAppNotification).toHaveBeenCalledTimes(2);
  });
});
