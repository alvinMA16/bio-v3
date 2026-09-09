export type ChatRole = 'user' | 'assistant' | 'system';

export interface SessionSummary {
  summary: string;
  topics: string[];
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export type ModelProvider = 'deepseek' | 'qwen' | 'openai-compatible';

export type AgentScene = 'conversation' | 'attachment_conversation' | 'revision';

/** Client snapshot captured when the user submits this turn; not authoritative document storage. */
export interface AgentWorkspaceSnapshot {
  documentId: string;
  version: number;
  title?: string;
  selectedBlockId?: string;
  excerpt: string;
}

export interface PanelAttachment {
  id: string;
  kind: 'image' | 'document';
  title: string;
  url?: string;
  text?: string;
}

export interface PanelBlock {
  id: string;
  kind: 'paragraph' | 'heading' | 'list' | 'quote' | 'code';
  text: string;
}

export interface PanelDocument {
  id: string;
  title: string;
  version: number;
  blocks: PanelBlock[];
}

export interface PanelState {
  revision: number;
  mode: 'conversation' | 'attachment' | 'editor';
  attachment?: PanelAttachment;
  document?: PanelDocument;
  lastChange?: { documentId: string; fromVersion: number; toVersion: number; before: PanelBlock[]; after: PanelBlock[] };
}

export interface AgentContextSnapshot {
  attachments?: PanelAttachment[];
  /** Requested mode only; actual mode and guidance follow the server's displayed content. */
  scene?: AgentScene;
  workspace?: AgentWorkspaceSnapshot;
}

export interface ChatCompletionRequest {
  context?: AgentContextSnapshot;
  provider?: ModelProvider;
  message: string;
  conversationId?: string;
  systemPrompt?: string;
}

export interface ModelTokenUsage {
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ModelCostEstimate {
  currency: 'CNY';
  usdToCnyRate: number;
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
  total: number;
}

export interface ChatCompletionResponse {
  conversationId: string;
  message: ChatMessage;
  finishReason: string | null;
  model: string;
  usage: ModelTokenUsage;
  estimatedCost: ModelCostEstimate;
  runId?: string;
  events?: AgentEvent[];
}

export interface MarkdownPanel {
  id: string;
  type: 'markdown';
  title: string;
  content: string;
}

/** Product events. Pi's internal event types stay on the server. */
export type AgentEventPayload =
  | { type: 'run.started' }
  | { type: 'speech.delta'; messageId: string; delta: string }
  | { type: 'speech.completed'; messageId: string; text: string }
  | { type: 'panel.updated'; panel: MarkdownPanel } // Legacy traces only.
  | { type: 'panel.state.updated'; panel: PanelState }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.completed'; toolCallId: string; name: string; isError: boolean }
  | { type: 'context.compacting' }
  | { type: 'context.compacted' }
  | { type: 'run.completed' }
  | { type: 'run.failed'; message: string }
  | { type: 'run.cancelled' };

export type AgentEvent = AgentEventPayload & {
  runId: string;
  conversationId: string;
  sequence: number;
  timestamp: string;
};

export interface AgentTraceEntry {
  runId: string;
  conversationId: string;
  sequence: number;
  timestamp: string;
  source: 'product' | 'pi' | 'input';
  type: string;
  data: unknown;
}

export type { VoiceRequest, VoiceClientMessage, VoiceServerMessage, VoiceState } from './voice.js';
