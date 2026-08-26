import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatCompletionResponse } from '@bio/contracts';
import { randomUUID } from 'node:crypto';

import {
  MODEL_PROVIDER,
  type ModelInput,
  type ModelProvider,
} from './model-provider';
import { estimateModelCost } from './model-pricing';

@Injectable()
export class ChatService {
  constructor(
    @Inject(MODEL_PROVIDER) private readonly modelProvider: ModelProvider,
    private readonly config: ConfigService,
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
    const configuredRate = Number(
      this.config.get<string>('USD_TO_CNY_RATE', '6.7829'),
    );
    const usdToCnyRate =
      Number.isFinite(configuredRate) && configuredRate > 0
        ? configuredRate
        : 6.7829;

    return {
      conversationId,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: completion.content,
        createdAt: new Date().toISOString(),
      },
      finishReason: completion.finishReason,
      model: completion.model,
      usage: completion.usage,
      estimatedCost: estimateModelCost(
        completion.model,
        completion.usage,
        usdToCnyRate,
      ),
    };
  }
}
