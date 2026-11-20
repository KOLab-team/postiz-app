import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class InstagramDmPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  after?: string;
}

export class InstagramDmReplyBody {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(/\S/, { message: 'text must contain non-whitespace characters' })
  text: string;
}

// Public API callers cannot opt automated replies into the Human Agent window.
export class InstagramDmHumanReplyBody extends InstagramDmReplyBody {
  @IsOptional()
  @IsBoolean()
  humanAgent?: boolean;
}
