import type { ModelCostEstimate, ModelTokenUsage } from '@bio/contracts';

interface ModelPrice {
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
}

const USD_PER_MILLION_TOKENS: Record<string, ModelPrice> = {
  'deepseek-v4-flash': {
    cacheHitInput: 0.0028,
    cacheMissInput: 0.14,
    output: 0.28,
  },
  // Legacy alias retained for old API responses during migration.
  'deepseek-chat': {
    cacheHitInput: 0.0028,
    cacheMissInput: 0.14,
    output: 0.28,
  },
};

export function getModelPrice(model: string): ModelPrice | undefined {
  return USD_PER_MILLION_TOKENS[model];
}

function tokenCost(tokens: number, pricePerMillion: number): number {
  return (tokens * pricePerMillion) / 1_000_000;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(10));
}

export function estimateModelCost(
  model: string,
  usage: ModelTokenUsage,
  usdToCnyRate: number,
): ModelCostEstimate {
  // Qwen mainland list prices are denominated in CNY, independent of FX.
  // https://help.aliyun.com/zh/model-studio/qwen3-8-flash
  const isQwen = model === 'qwen3.8-flash';
  const price = isQwen
    ? { cacheHitInput: 0.1, cacheMissInput: 0.8, output: 2.7 }
    : USD_PER_MILLION_TOKENS[model];
  const conversion = isQwen ? 1 : usdToCnyRate;
  if (!price) {
    return {
      currency: 'CNY',
      usdToCnyRate,
      cacheHitInput: 0,
      cacheMissInput: 0,
      output: 0,
      total: 0,
    };
  }

  const cacheHitInput = tokenCost(
    usage.promptCacheHitTokens,
    price.cacheHitInput,
  );
  const cacheMissInput = tokenCost(
    usage.promptCacheMissTokens,
    price.cacheMissInput,
  );
  const output = tokenCost(usage.completionTokens, price.output);

  return {
    currency: 'CNY',
    usdToCnyRate,
    cacheHitInput: roundCurrency(cacheHitInput * conversion),
    cacheMissInput: roundCurrency(cacheMissInput * conversion),
    output: roundCurrency(output * conversion),
    total: roundCurrency(
      (cacheHitInput + cacheMissInput + output) * conversion,
    ),
  };
}
