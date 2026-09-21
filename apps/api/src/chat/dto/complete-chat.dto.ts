import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, IsInt, IsNumber, Min, Max, ValidateNested, IsDefined, IsArray, ArrayMaxSize, IsUrl, ValidateIf } from 'class-validator';

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

export class AttachmentViewDto {
  @IsUUID('4') materialId!: string;
  @IsInt() @Min(1) page!: number;
}
export class VisibleDocumentRangeDto {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) blockId!: string;
  @IsInt() @Min(0) start!: number;
  @IsInt() @Min(0) end!: number;
}
export class DocumentNavigationReceiptDto {
  @IsUUID('4') requestId!: string;
  @IsIn(['received', 'rendering', 'visible', 'failed']) status!: 'received' | 'rendering' | 'visible' | 'failed';
  @IsOptional() @IsIn(['target_missing', 'scroller_missing', 'not_visible', 'user_interrupted']) reason?: 'target_missing' | 'scroller_missing' | 'not_visible' | 'user_interrupted';
  @IsInt() @Min(0) @Max(6) attempts!: number;
  @IsNumber() @Min(0) @Max(10000000) scrollBefore!: number;
  @IsNumber() @Min(0) @Max(10000000) scrollAfter!: number;
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_.-]{1,120}$/) clientBuild?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(86400000) elapsedMs?: number;
  @IsOptional() @IsNumber() @Min(-10000000) @Max(10000000) targetTop?: number;
  @IsOptional() @IsNumber() @Min(-10000000) @Max(10000000) targetBottom?: number;
  @IsOptional() @IsNumber() @Min(-10000000) @Max(10000000) viewportTop?: number;
  @IsOptional() @IsNumber() @Min(-10000000) @Max(10000000) viewportBottom?: number;
  @IsOptional() @IsIn(['not_requested', 'visible', 'not_visible', 'missing']) highlight?: 'not_requested' | 'visible' | 'not_visible' | 'missing';
}
export class DocumentViewDto {
  @IsOptional() @ValidateNested() @Type(() => DocumentNavigationReceiptDto)
  navigation?: DocumentNavigationReceiptDto;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VisibleDocumentRangeDto)
  visibleRanges?: VisibleDocumentRangeDto[];
  @IsOptional() @IsBoolean() following?: boolean;
  @IsOptional() @IsInt() @Min(0) followRequest?: number;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) documentId!: string;
  @IsInt() @Min(1) version!: number;
  @IsInt() @Min(1) page!: number;
}
export class ContextSnapshotDto implements AgentContextSnapshot {
  @IsOptional() @ValidateNested() @Type(() => DocumentViewDto)
  documentView?: DocumentViewDto;
  @IsOptional() @ValidateNested() @Type(() => AttachmentViewDto)
  attachmentView?: AttachmentViewDto;
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
  @IsIn(['deepseek', 'qwen', 'gemini', 'openai-compatible'])
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
