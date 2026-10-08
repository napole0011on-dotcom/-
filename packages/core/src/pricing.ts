import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Model prices live in a JSON file (config/model-pricing.json), not in code, so they
 * can be updated without a release. All prices are USD per 1M tokens.
 */

const rates = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative(),
});

const modelPrice = rates.extend({
  longContext: rates.extend({ thresholdPromptTokens: z.number().int().positive() }).optional(),
});

const pricingFile = z.object({
  currency: z.literal('USD'),
  verifiedAt: z.string(),
  models: z.record(z.string(), modelPrice).refine((m) => Object.keys(m).length > 0, {
    error: 'at least one model is required',
  }),
});

export type ModelPricing = z.infer<typeof pricingFile>;
type Rates = z.infer<typeof rates>;

export function parsePricing(raw: unknown): ModelPricing {
  return pricingFile.parse(raw);
}

export function loadPricing(file: string): ModelPricing {
  try {
    return parsePricing(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Cannot load model pricing from ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export interface TokenUsage {
  /** Uncached input tokens (Anthropic `input_tokens` excludes cache reads/writes). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export interface CostResult {
  usd: number;
  /** True when the model was not in the price list and the most expensive rates were used. */
  estimated: boolean;
}

function mostExpensive(pricing: ModelPricing): Rates {
  const all = Object.values(pricing.models).flatMap((m) =>
    m.longContext ? [m, m.longContext] : [m],
  );
  const max = (k: keyof Rates) => Math.max(...all.map((r) => r[k]));
  return {
    input: max('input'),
    output: max('output'),
    cacheRead: max('cacheRead'),
    cacheWrite5m: max('cacheWrite5m'),
    cacheWrite1h: max('cacheWrite1h'),
  };
}

/** Rounds to 1e-8 USD to keep float noise out of stored values. */
const round = (usd: number) => Math.round(usd * 1e8) / 1e8;

export function computeLlmCost(
  pricing: ModelPricing,
  model: string,
  usage: TokenUsage,
): CostResult {
  const entry = pricing.models[model];
  let r: Rates;
  if (!entry) {
    r = mostExpensive(pricing);
  } else {
    const prompt =
      usage.inputTokens +
      usage.cacheReadTokens +
      usage.cacheWrite5mTokens +
      usage.cacheWrite1hTokens;
    r =
      entry.longContext && prompt > entry.longContext.thresholdPromptTokens
        ? entry.longContext
        : entry;
  }
  const usd =
    (usage.inputTokens * r.input +
      usage.outputTokens * r.output +
      usage.cacheReadTokens * r.cacheRead +
      usage.cacheWrite5mTokens * r.cacheWrite5m +
      usage.cacheWrite1hTokens * r.cacheWrite1h) /
    1_000_000;
  return { usd: round(usd), estimated: !entry };
}

/** Upper bound for a call before it is made: used to reserve budget. */
export function estimateMaxLlmCost(
  pricing: ModelPricing,
  model: string,
  promptTokensEstimate: number,
  maxOutputTokens: number,
): number {
  // Worst case: whole prompt billed as an uncached 1h cache write, all output tokens used.
  return computeLlmCost(pricing, model, {
    inputTokens: 0,
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: promptTokensEstimate,
  }).usd;
}
