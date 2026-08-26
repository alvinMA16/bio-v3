import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ModelCompletion,
  ModelInput,
  ModelProvider,
} from './model-provider';

interface DeepSeekResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
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
        model: this.config.get<string>(
          'DEEPSEEK_MODEL',
          'deepseek-v4-flash',
        ),
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
    if (!choice?.message?.content || !parsed.usage) {
      throw new ServiceUnavailableException(
        'DeepSeek returned an incomplete completion',
      );
    }

    const promptTokens = parsed.usage.prompt_tokens ?? 0;
    const promptCacheHitTokens = parsed.usage.prompt_cache_hit_tokens ?? 0;
    const promptCacheMissTokens =
      parsed.usage.prompt_cache_miss_tokens ??
      Math.max(0, promptTokens - promptCacheHitTokens);
    const completionTokens = parsed.usage.completion_tokens ?? 0;

    return {
      content: choice.message.content,
      finishReason: choice.finish_reason ?? null,
      model:
        parsed.model ??
        this.config.get<string>('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
      usage: {
        promptTokens,
        promptCacheHitTokens,
        promptCacheMissTokens,
        completionTokens,
        reasoningTokens:
          parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens:
          parsed.usage.total_tokens ?? promptTokens + completionTokens,
      },
    };
  }
}
