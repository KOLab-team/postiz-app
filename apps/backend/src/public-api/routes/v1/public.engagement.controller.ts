import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PublicEngagementService } from '../../public.engagement.service';
import {
  AccountAnalyticsQuery,
  CommentListQuery,
  CommentVisibilityBody,
  PostTargetQuery,
  ReplyBody,
} from '../../engagement.dto';

@ApiTags('Public API — Engagement')
@Controller('/public/v1')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  })
)
export class PublicEngagementController {
  constructor(private readonly engagement: PublicEngagementService) {}

  @Get('/analytics/post/:id')
  postAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: PostTargetQuery
  ) {
    return this.engagement.postAnalytics(org.id, id, query);
  }

  @Get('/analytics/:integration')
  accountAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') id: string,
    @Query() query: AccountAnalyticsQuery
  ) {
    return this.engagement.accountAnalytics(org.id, id, query.date);
  }

  @Get('/posts/:id/comments')
  listComments(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: CommentListQuery
  ) {
    return this.engagement.listComments(org.id, id, query);
  }

  @Post('/posts/:id/comments')
  reply(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: PostTargetQuery,
    @Body() body: ReplyBody
  ) {
    return this.engagement.reply(org.id, id, query, body);
  }

  @Put('/posts/:id/comments/:commentId/hide')
  setCommentHidden(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Query() query: PostTargetQuery,
    @Body() body: CommentVisibilityBody
  ) {
    return this.engagement.setCommentHidden(
      org.id,
      id,
      commentId,
      query,
      body.hide
    );
  }

  @Delete('/posts/:id/comments/:commentId')
  deleteComment(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Query() query: PostTargetQuery
  ) {
    return this.engagement.deleteComment(org.id, id, commentId, query);
  }
}
