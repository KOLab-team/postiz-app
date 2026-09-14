import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PostTargetQuery {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  integrationId?: string;

  // Kept for existing MCP callers; Threads post insights are lifetime metrics.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  date?: string;
}

export class CommentListQuery extends PostTargetQuery {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class AccountAnalyticsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  date = 30;
}

export class ReplyBody {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @Matches(/\S/, { message: 'text must contain non-whitespace characters' })
  text: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  replyToCommentId?: string;
}

export class CommentVisibilityBody {
  @IsBoolean()
  hide: boolean;
}
