import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CompleteChatDto {
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
