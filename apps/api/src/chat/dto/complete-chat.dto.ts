import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import type { ModelProvider } from '@bio/contracts';

export class CompleteChatDto {
  @IsOptional()
  @IsIn(['deepseek', 'qwen', 'openai-compatible'])
  provider?: ModelProvider;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(20_000)
  message!: string;

  @IsUUID('4')
  @IsOptional()
  conversationId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10_000)
  systemPrompt?: string;
}
