import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  message!: string;

  @IsString()
  @IsOptional()
  conversationId?: string;
}
