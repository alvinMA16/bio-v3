export interface ModelInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelDelta {
  content: string;
  finishReason: string | null;
}

export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');

export interface ModelProvider {
  stream(messages: ModelInput[], signal?: AbortSignal): AsyncGenerator<ModelDelta>;
}
