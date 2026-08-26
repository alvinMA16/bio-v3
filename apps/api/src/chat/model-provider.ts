import type { ModelTokenUsage } from '@bio/contracts';

export interface ModelInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelCompletion {
  content: string;
  finishReason: string | null;
  model: string;
  usage: ModelTokenUsage;
}

export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');

export interface ModelProvider {
  complete(messages: ModelInput[], signal?: AbortSignal): Promise<ModelCompletion>;
}
