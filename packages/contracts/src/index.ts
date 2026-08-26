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
}
