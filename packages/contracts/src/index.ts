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

export interface ChatCompletionResponse {
  conversationId: string;
  message: ChatMessage;
  finishReason: string | null;
}
