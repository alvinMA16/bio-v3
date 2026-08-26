import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ModelCompletion,
  ModelInput,
  ModelProvider,
} from './model-provider';

interface DeepSeekResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
}

@Injectable()
export class DeepSeekProvider implements ModelProvider {
  constructor(private readonly config: ConfigService) {}

  async complete(
    messages: ModelInput[],
    signal?: AbortSignal,
  ): Promise<ModelCompletion> {
    const apiKey = this.config.get<string>('DEEPSEEK_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('DEEPSEEK_API_KEY is not configured');
    }

    const baseUrl = this.config.get<string>(
      'DEEPSEEK_BASE_URL',
      'https://api.deepseek.com',
    );
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.get<string>('DEEPSEEK_MODEL', 'deepseek-chat'),
        messages,
        stream: false,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new ServiceUnavailableException(
        `DeepSeek request failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const parsed = (await response.json()) as DeepSeekResponse;
    const choice = parsed.choices?.[0];
    if (!choice?.message?.content) {
      throw new ServiceUnavailableException(
        'DeepSeek returned an empty completion',
      );
    }

    return {
      content: choice.message.content,
      finishReason: choice.finish_reason ?? null,
    };
  }
}
