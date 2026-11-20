import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { createHash } from 'crypto';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

@Injectable()
export class InstagramDmHealthService {
  private readonly logger = new Logger(InstagramDmHealthService.name);

  constructor(private readonly notifications: NotificationService) {}

  async reconnectRequired(integration: Integration) {
    // Deduplicate across API/worker processes, without storing the credential.
    // A reconnected account gets a new key even during the previous cooldown.
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          integration.organizationId,
          integration.id,
          integration.token,
        ])
      )
      .digest('hex');
    const key = `instagram-dm-reconnect:${fingerprint}`;
    try {
      const claimed = await ioRedis.set(key, '1', 'EX', 3600, 'NX');
      if (claimed !== 'OK') return;
      try {
        await this.notifications.inAppNotification(
          integration.organizationId,
          'Instagram DM access needs reconnection',
          `Instagram DM access has expired or been revoked for channel ${integration.id}. Open your connected channels and reconnect the Instagram account to restore access.`,
          true,
          false,
          'info'
        );
      } catch {
        await ioRedis.del(key);
        this.logger.warn(
          'Could not deliver the Instagram DM reconnection notification.'
        );
      }
    } catch {
      // Notification outages must not hide the original authentication failure.
      this.logger.warn(
        'Could not record the Instagram DM reconnection notification.'
      );
    }
  }
}
