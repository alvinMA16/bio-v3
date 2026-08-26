import { Inject, Injectable } from '@nestjs/common';
import type { ChatCompletionResponse } from '@bio/contracts';
import { randomUUID } from 'node:crypto';

import {
  MODEL_PROVIDER,
  type ModelInput,
  type ModelProvider,
} from './model-provider';

@Injectable()
export class ChatService {
  constructor(
    @Inject(MODEL_PROVIDER) private readonly modelProvider: ModelProvider,
  ) {}

  async complete(
    message: string,
    conversationId: string = randomUUID(),
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const messages: ModelInput[] = [];
    if (systemPrompt?.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: message });

    const completion = await this.modelProvider.complete(
      messages,
      signal,
    );

    return {
      conversationId,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: completion.content,
        createdAt: new Date().toISOString(),
      },
      finishReason: completion.finishReason,
    };
  }
}
