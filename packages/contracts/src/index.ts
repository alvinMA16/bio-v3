export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface StreamStartEvent {
  type: 'start';
  conversationId: string;
  messageId: string;
}

export interface StreamDeltaEvent {
  type: 'delta';
  content: string;
}

export interface StreamDoneEvent {
  type: 'done';
  finishReason: string | null;
}

export interface StreamErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export type ChatStreamEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamDoneEvent
  | StreamErrorEvent;
