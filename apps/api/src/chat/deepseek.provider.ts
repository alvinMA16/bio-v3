import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ModelDelta, ModelInput, ModelProvider } from './model-provider';

interface DeepSeekChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

@Injectable()
export class DeepSeekProvider implements ModelProvider {
  constructor(private readonly config: ConfigService) {}

  async *stream(
    messages: ModelInput[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelDelta> {
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
        stream: true,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new ServiceUnavailableException(
        `DeepSeek request failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const payload = line.trim();
        if (!payload.startsWith('data:')) continue;

        const data = payload.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        const parsed = JSON.parse(data) as DeepSeekChunk;
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        yield {
          content: choice.delta?.content ?? '',
          finishReason: choice.finish_reason ?? null,
        };
      }
    }
  }
}
