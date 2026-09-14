import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  EngagementError,
  SocialEngagement,
} from '@gitroom/nestjs-libraries/integrations/social/social.engagement';
import { CommentListQuery, PostTargetQuery, ReplyBody } from './engagement.dto';

@Injectable()
export class PublicEngagementService {
  constructor(
    private readonly integrations: IntegrationService,
    private readonly posts: PostsRepository,
    private readonly providers: IntegrationManager,
    private readonly refresh: RefreshIntegrationService
  ) {}

  private async integration(orgId: string, id: string) {
    const integration = await this.integrations.getIntegrationById(orgId, id);
    if (!integration || integration.deletedAt)
      throw new NotFoundException('Connected channel not found.');
    if (integration.disabled || integration.type !== 'social')
      throw new BadRequestException(
        'The channel must be an enabled social integration.'
      );
    return integration;
  }

  private async refreshToken(
    integration: Integration,
    provider: SocialProvider
  ) {
    const refreshed = await this.refresh.refresh(integration);
    if (!refreshed || !refreshed.accessToken)
      throw new UnauthorizedException(
        'Reconnect this channel to restore access.'
      );
    integration.token = refreshed.accessToken;
    if (provider.refreshWait)
      await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  private async withToken<T>(
    integration: Integration,
    provider: SocialProvider,
    operation: (token: string) => Promise<T>
  ): Promise<T> {
    let refreshed = false;
    if (
      integration.tokenExpiration &&
      integration.tokenExpiration.getTime() <= Date.now()
    ) {
      await this.refreshToken(integration, provider);
      refreshed = true;
    }
    for (;;) {
      try {
        return await operation(integration.token);
      } catch (error) {
        const expired =
          error instanceof RefreshToken ||
          (error instanceof EngagementError && error.expiredToken);
        if (expired && !refreshed) {
          await this.refreshToken(integration, provider);
          refreshed = true;
          continue;
        }
        if (error instanceof EngagementError)
          throw new HttpException(error.message, error.status);
        if (error instanceof HttpException) throw error;
        if (expired)
          throw new UnauthorizedException(
            'Reconnect this channel to restore access.'
          );
        // Provider errors can contain credentials in URLs/bodies. Do not serialize them.
        throw new HttpException(
          'The social platform request failed. Check the platform before retrying a write.',
          502
        );
      }
    }
  }

  async accountAnalytics(orgId: string, integrationId: string, days: number) {
    const integration = await this.integration(orgId, integrationId);
    const provider = this.providers.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!provider?.analytics)
      throw new NotImplementedException(
        'Account analytics are not supported for this provider.'
      );
    const analytics = await this.withToken(integration, provider, (token) =>
      provider.analytics(integration.internalId, token, days)
    );
    // Some legacy providers set percentageChange to a hard-coded placeholder.
    // Expose their actual metric series without presenting that as a measured trend.
    return analytics.map(({ label, data }) => ({ label, data }));
  }

  private async onPost(
    orgId: string,
    postId: string,
    query: PostTargetQuery,
    operation: (
      api: SocialEngagement,
      token: string,
      nativeId: string,
      accountId: string
    ) => Promise<unknown>,
    allowLegacyAnalytics = false
  ) {
    let integrationId = query.integrationId;
    let nativeId = postId;
    if (!integrationId) {
      // Always scope the lookup to the API key's organization.
      const post = await this.posts.getPost(postId, false, orgId);
      if (!post)
        throw new NotFoundException(
          'Post not found. For a platform post ID, supply integrationId.'
        );
      if (post.state !== 'PUBLISHED' || !post.releaseId)
        throw new BadRequestException('The post has not been published.');
      integrationId = post.integrationId;
      nativeId = post.releaseId;
    }
    const integration = await this.integration(orgId, integrationId);
    const provider = this.providers.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!provider?.engagement) {
      // Preserve main's existing analytics support for other providers. Native
      // IDs require an ownership verifier, so this path accepts Postiz IDs only.
      if (
        allowLegacyAnalytics &&
        provider?.postAnalytics &&
        !query.integrationId
      ) {
        const days = Number(query.date ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new BadRequestException(
            'date must be days back between 1 and 365.'
          );
        }
        return this.withToken(integration, provider, (token) =>
          provider.postAnalytics(integration.internalId, token, nativeId, days)
        );
      }
      throw new NotImplementedException(
        'This provider does not support the requested post engagement operation.'
      );
    }
    return this.withToken(integration, provider, async (token) => {
      await provider.engagement.assertOwnedPost(
        token,
        integration.internalId,
        nativeId
      );
      return operation(
        provider.engagement,
        token,
        nativeId,
        integration.internalId
      );
    });
  }

  postAnalytics(orgId: string, postId: string, query: PostTargetQuery) {
    return this.onPost(
      orgId,
      postId,
      query,
      (api, token, id) => api.postAnalytics(token, id),
      true
    );
  }

  listComments(orgId: string, postId: string, query: CommentListQuery) {
    return this.onPost(orgId, postId, query, (api, token, id) =>
      api.listComments(token, id, query)
    );
  }

  reply(
    orgId: string,
    postId: string,
    query: PostTargetQuery,
    body: ReplyBody
  ) {
    return this.onPost(orgId, postId, query, (api, token, id, accountId) =>
      api.reply(token, accountId, id, body.text, body.replyToCommentId)
    );
  }

  setCommentHidden(
    orgId: string,
    postId: string,
    commentId: string,
    query: PostTargetQuery,
    hide: boolean
  ) {
    return this.onPost(orgId, postId, query, (api, token, id) =>
      api.setCommentHidden(token, id, commentId, hide)
    );
  }

  deleteComment(
    orgId: string,
    postId: string,
    commentId: string,
    query: PostTargetQuery
  ) {
    return this.onPost(orgId, postId, query, (api, token, id) =>
      api.deleteComment(token, id, commentId)
    );
  }
}
