import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, IsInt, Min, ValidateNested, IsDefined, IsArray, ArrayMaxSize, IsUrl, ValidateIf } from 'class-validator';

import { Type } from 'class-transformer';

import type { AgentContextSnapshot, AgentScene, AgentWorkspaceSnapshot, ModelProvider } from '@bio/contracts';

export class WorkspaceSnapshotDto implements AgentWorkspaceSnapshot {
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  documentId!: string;

  @IsInt()
  @Min(0)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  selectedBlockId?: string;

  @IsDefined()
  @IsString()
  @MaxLength(12000)
  excerpt!: string;
}

export class PanelAttachmentDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,64}$/)
  id!: string;

  @IsIn(['image', 'document'])
  kind!: 'image' | 'document';

  @IsString()
  @Matches(/\S/)
  @MaxLength(300)
  title!: string;

  @ValidateIf((value: PanelAttachmentDto) => value.kind === 'image' || value.url != null || !value.text)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  text?: string;
}

export class ContextSnapshotDto implements AgentContextSnapshot {
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('4', { each: true })
  materialIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PanelAttachmentDto)
  attachments?: PanelAttachmentDto[];

  @IsOptional()
  @IsIn(['conversation', 'attachment_conversation', 'revision'])
  scene?: AgentScene;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkspaceSnapshotDto)
  workspace?: WorkspaceSnapshotDto;
}

export class CompleteChatDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ContextSnapshotDto)
  context?: ContextSnapshotDto;

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
