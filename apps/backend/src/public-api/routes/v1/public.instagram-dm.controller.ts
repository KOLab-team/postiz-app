import { Body, Controller, Get, Param, Post, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { InstagramDmPageQuery, InstagramDmReplyBody } from '../../instagram-dm.dto';
import { PublicInstagramDmService } from '../../public.instagram-dm.service';

@ApiTags('Public API — Instagram DMs')
@Controller('/public/v1/integrations/:integrationId/instagram-dms')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class PublicInstagramDmController {
  constructor(private readonly dms: PublicInstagramDmService) {}

  @Get('/conversations')
  conversations(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Query() query: InstagramDmPageQuery
  ) {
    return this.dms.conversations(org.id, integrationId, query);
  }

  @Get('/conversations/:conversationId/messages')
  messages(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Param('conversationId') conversationId: string,
    @Query() query: InstagramDmPageQuery
  ) {
    return this.dms.messages(org.id, integrationId, conversationId, query);
  }

  @Post('/conversations/:conversationId/replies')
  reply(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: InstagramDmReplyBody
  ) {
    return this.dms.reply(org.id, integrationId, conversationId, body.text);
  }
}
