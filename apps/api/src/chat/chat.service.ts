import { Inject, Injectable } from '@nestjs/common';
import type { ChatCompletionResponse } from '@bio/contracts';
import { randomUUID } from 'node:crypto';

import { MODEL_PROVIDER, type ModelProvider } from './model-provider';

@Injectable()
export class ChatService {
  constructor(
    @Inject(MODEL_PROVIDER) private readonly modelProvider: ModelProvider,
  ) {}

  async complete(
    message: string,
    conversationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const completion = await this.modelProvider.complete(
      [{ role: 'user', content: message }],
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
