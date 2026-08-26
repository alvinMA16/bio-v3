import { Inject, Injectable } from '@nestjs/common';
import type { ChatStreamEvent } from '@bio/contracts';
import { randomUUID } from 'node:crypto';

import { MODEL_PROVIDER, type ModelProvider } from './model-provider';

@Injectable()
export class ChatService {
  constructor(
    @Inject(MODEL_PROVIDER) private readonly modelProvider: ModelProvider,
  ) {}

  async *stream(
    message: string,
    conversationId: string = randomUUID(),
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    yield {
      type: 'start',
      conversationId,
      messageId: randomUUID(),
    };

    let finishReason: string | null = null;
    for await (const delta of this.modelProvider.stream(
      [{ role: 'user', content: message }],
      signal,
    )) {
      finishReason = delta.finishReason ?? finishReason;
      if (delta.content) yield { type: 'delta', content: delta.content };
    }

    yield { type: 'done', finishReason };
  }
}
