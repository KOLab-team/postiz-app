import { BadRequestException, ForbiddenException } from '@nestjs/common';

export function validateInstagramDmText(text: string) {
  if (!text?.trim() || Buffer.byteLength(text, 'utf8') > 1000) {
    throw new BadRequestException(
      'Instagram replies must contain text and fit within 1000 UTF-8 bytes.'
    );
  }
}

export function assertInstagramHumanAgentEnabled() {
  if (
    process.env.INSTAGRAM_DM_HUMAN_AGENT_ENABLED !== 'true' ||
    process.env.META_PUBLISHING_ONLY === 'true'
  ) {
    throw new ForbiddenException(
      'Human Agent replies are not enabled for this app. Enable them after Meta grants Human Agent access.'
    );
  }
}

export function assertInstagramHumanAgentWindow(
  lastInbound: Date | null,
  now = Date.now()
) {
  const timestamp = lastInbound?.getTime();
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp >= 7 * 24 * 60 * 60 * 1000
  ) {
    throw new ForbiddenException(
      'A Human Agent reply requires a verified customer message within the last 7 days.'
    );
  }
}
