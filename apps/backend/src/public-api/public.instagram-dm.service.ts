import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { InstagramDmPageQuery } from './instagram-dm.dto';

type GraphPage<T> = {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
};
type GraphError = { error?: { code?: number; type?: string; error_subcode?: number } };
type Participant = { id?: string; name?: string; username?: string };

const GRAPH_VERSION = 'v25.0';
const GRAPH_TIMEOUT_MS = 12000;

@Injectable()
export class PublicInstagramDmService {
  constructor(
    private readonly integrations: IntegrationService,
    private readonly refresh: RefreshIntegrationService
  ) {}

  private async integration(orgId: string, id: string) {
    const integration = await this.integrations.getIntegrationById(orgId, id);
    if (!integration || integration.deletedAt)
      throw new NotFoundException('Connected channel not found.');
    if (
      integration.disabled ||
      integration.inBetweenSteps ||
      integration.type !== 'social'
    )
      throw new BadRequestException('The channel must be an enabled Instagram connection.');
    if (!['instagram-standalone', 'instagram'].includes(integration.providerIdentifier))
      throw new BadRequestException('This channel is not an Instagram connection.');
    return integration;
  }

  private graphHost(integration: Integration) {
    return integration.providerIdentifier === 'instagram-standalone'
      ? 'graph.instagram.com'
      : 'graph.facebook.com';
  }

  private async graph<T>(
    integration: Integration,
    path: string,
    params: Record<string, string>,
    token: string,
    body?: object
  ): Promise<T> {
    // Paths are made only from IDs checked by the caller. No Meta paging URL is followed.
    const url = new URL(`https://${this.graphHost(integration)}/${GRAPH_VERSION}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException(body
        ? 'Instagram did not confirm the reply. Check the conversation before trying again.'
        : 'Instagram did not respond.');
    }
    if (!response.ok) {
      // Meta's body and URLs can contain credentials. Expose only a fixed message.
      const body = (await response.json().catch(() => ({}))) as GraphError;
      if (body.error?.code === 190 || response.status === 401)
        throw new UnauthorizedException('Reconnect Instagram in Postiz to restore DM access.');
      if ([10, 200].includes(body.error?.code ?? 0) || response.status === 403)
        throw new ForbiddenException('Instagram messaging permission is missing. Reconnect in Postiz and check Meta app access.');
      if (response.status === 429)
        throw new HttpException('Instagram rate limit reached. Retry later.', 429);
      if (response.status === 404)
        throw new NotFoundException('Instagram conversation not found.');
      if (body && response.status === 400)
        throw new BadRequestException('Instagram rejected this reply. Check that the conversation is eligible for replies.');
      throw new BadGatewayException(body
        ? 'Instagram could not confirm the reply. Check the conversation before trying again.'
        : 'Instagram could not complete the DM read.');
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new BadGatewayException('Instagram returned an invalid response.');
    }
  }

  private async withToken<T>(
    integration: Integration,
    operation: (token: string) => Promise<T>
  ): Promise<T> {
    // Instagram Login tokens can be refreshed by Postiz; Facebook Page tokens
    // require a new Facebook authorization when they cease to work.
    const standalone = integration.providerIdentifier === 'instagram-standalone';
    const refresh = async () => {
      // A DM GET must never disconnect an account used for publishing.
      const refreshed = await this.refresh.refresh(integration, {
        disconnectOnFailure: false,
      });
      if (refreshed === false || !refreshed.accessToken)
        throw new UnauthorizedException('Reconnect Instagram in Postiz to restore DM access.');
      integration.token = refreshed.accessToken;
    };
    let refreshed = false;
    if (standalone && integration.tokenExpiration && integration.tokenExpiration.getTime() <= Date.now()) {
      await refresh();
      refreshed = true;
    }
    try {
      return await operation(integration.token);
    } catch (error) {
      if (!(error instanceof UnauthorizedException) || !standalone || refreshed)
        throw error;
      await refresh();
      return operation(integration.token);
    }
  }

  private page<T>(result: GraphPage<T>) {
    return {
      data: result.data ?? [],
      paging: { after: result.paging?.next ? result.paging.cursors?.after ?? null : null },
    };
  }

  private async accountPath(integration: Integration, token: string) {
    if (integration.providerIdentifier === 'instagram-standalone')
      return integration.internalId;
    const page = await this.graph<{
      id?: string;
      instagram_business_account?: { id?: string };
    }>(integration, 'me', { fields: 'id,instagram_business_account' }, token);
    if (page.instagram_business_account?.id !== integration.internalId || !page.id)
      throw new ForbiddenException('The connected Facebook Page does not own this Instagram account.');
    return page.id;
  }

  private async verifiedConversation(
    integration: Integration,
    conversationId: string,
    token: string
  ) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(conversationId))
      throw new BadRequestException('Invalid Instagram conversation ID.');
    const accountId = await this.accountPath(integration, token);
    const ownerIds = [integration.internalId, accountId];
    if (integration.providerIdentifier === 'instagram-standalone') {
      const me = await this.graph<{ id?: string; user_id?: string }>(
        integration, 'me', { fields: 'id,user_id' }, token
      );
      if (me.user_id !== integration.internalId || !me.id)
        throw new ForbiddenException('The token does not belong to this Instagram account.');
      ownerIds.push(me.id);
    }
    const conversation = await this.graph<{
      id?: string;
      participants?: { data?: Participant[] };
    }>(integration, conversationId, { fields: 'id,participants' }, token);
    const participants = conversation.participants?.data ?? [];
    if (
      conversation.id !== conversationId ||
      !participants.some((participant) => participant.id && ownerIds.includes(participant.id))
    ) throw new NotFoundException('Instagram conversation not found for this channel.');
    return { accountId, ownerIds, participants };
  }

  async conversations(orgId: string, integrationId: string, query: InstagramDmPageQuery) {
    const integration = await this.integration(orgId, integrationId);
    return this.withToken(integration, async (token) => {
      const accountId = await this.accountPath(integration, token);
      const result = await this.graph<GraphPage<{
        id: string;
        updated_time?: string;
        participants?: { data?: { id: string; name?: string; username?: string }[] };
      }>>(integration, `${accountId}/conversations`, {
        ...(integration.providerIdentifier === 'instagram' ? { platform: 'instagram' } : {}),
        fields: 'id,updated_time,participants',
        limit: String(query.limit),
        ...(query.after ? { after: query.after } : {}),
      }, token);
      return { integrationId, ...this.page(result) };
    });
  }

  async messages(
    orgId: string,
    integrationId: string,
    conversationId: string,
    query: InstagramDmPageQuery
  ) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(conversationId))
      throw new BadRequestException('Invalid Instagram conversation ID.');
    const integration = await this.integration(orgId, integrationId);
    return this.withToken(integration, async (token) => {
      const verified = await this.verifiedConversation(integration, conversationId, token);
      const result = await this.graph<GraphPage<{
        id: string;
        created_time?: string;
        from?: { id: string; username?: string };
        to?: { data?: { id: string; username?: string }[] };
        message?: string;
        attachments?: { data?: unknown[] };
      }>>(integration, `${conversationId}/messages`, {
        fields: 'id,created_time,from,to,message,attachments',
        limit: String(query.limit),
        ...(query.after ? { after: query.after } : {}),
      }, token);
      return {
        integrationId,
        conversationId,
        accountParticipantId: verified.participants.find((participant) =>
          participant.id && verified.ownerIds.includes(participant.id)
        )?.id,
        ...this.page(result),
      };
    });
  }

  async reply(orgId: string, integrationId: string, conversationId: string, text: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(conversationId))
      throw new BadRequestException('Invalid Instagram conversation ID.');
    const integration = await this.integration(orgId, integrationId);
    // The read-only verification may refresh a token. The send itself is never replayed.
    const { accountId, ownerIds, participants } = await this.withToken(
      integration, (token) => this.verifiedConversation(integration, conversationId, token)
    );
    const token = integration.token;
    const recipients = participants.filter((participant) =>
      participant.id && !ownerIds.includes(participant.id)
    );
    if (recipients.length !== 1 || participants.length !== 2)
      throw new BadRequestException('This conversation does not have one verified recipient.');
    const sent = await this.graph<{ recipient_id?: string; message_id?: string }>(
      integration, `${accountId}/messages`, {}, token,
      {
        recipient: { id: recipients[0].id },
        message: { text },
        ...(integration.providerIdentifier === 'instagram' ? { message_type: 'RESPONSE' } : {}),
      }
    );
    if (!sent.message_id || sent.recipient_id !== recipients[0].id)
      throw new BadGatewayException('Instagram did not confirm the reply. Check the conversation before trying again.');
    return { messageId: sent.message_id };
  }
}
