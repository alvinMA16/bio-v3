import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelProvider } from '@bio/contracts';
import { join } from 'node:path';
import { getModelPrice } from '../chat/model-pricing.js';

// Provider-specific protocol details stay outside the Agent/session lifecycle.
const providers = {
  deepseek: { prefix: 'DEEPSEEK', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', contextWindow: 131072, thinkingFormat: 'deepseek' },
  qwen: { prefix: 'QWEN', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-flash', contextWindow: 1000000, thinkingFormat: 'qwen' },
  'openai-compatible': { prefix: 'LLM', baseUrl: '', model: '', contextWindow: 131072, thinkingFormat: undefined },
} as const;

export async function createModelRuntime(config: ConfigService, cwd: string, requested?: ModelProvider) {
  const selected = requested ?? config.get<string>('MODEL_PROVIDER', 'deepseek');
  if (!Object.hasOwn(providers, selected)) throw new ServiceUnavailableException('Unknown MODEL_PROVIDER');
  const profile = providers[selected as ModelProvider];
  const apiKey = config.get<string>(`${profile.prefix}_API_KEY`)?.trim();
  if (!apiKey) throw new ServiceUnavailableException(`${profile.prefix}_API_KEY is not configured`);
  const baseUrl = config.get<string>(`${profile.prefix}_BASE_URL`, profile.baseUrl).trim();
  const modelId = config.get<string>(`${profile.prefix}_MODEL`, profile.model).trim();
  if (!baseUrl || !modelId) throw new ServiceUnavailableException(`${profile.prefix}_BASE_URL and ${profile.prefix}_MODEL are required`);
  const providerId = `bio-${selected}`;
  const price = getModelPrice(modelId);
  // Isolate credentials and model discovery from the developer's global config.
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider(providerId, {
    api: 'openai-completions', baseUrl,
    models: [{
      id: modelId, name: modelId, reasoning: !!profile.thinkingFormat, input: ['text'],
      contextWindow: profile.contextWindow, maxTokens: 8192,
      cost: { input: price?.cacheMissInput ?? 0, output: price?.output ?? 0, cacheRead: price?.cacheHitInput ?? 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', thinkingFormat: profile.thinkingFormat },
    }],
  });
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) throw new ServiceUnavailableException('Agent model is unavailable');
  return { modelRuntime, model };
}
