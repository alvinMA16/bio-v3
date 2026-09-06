export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ChatCompletionRequest {
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
  | { type: 'panel.updated'; panel: MarkdownPanel }
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
