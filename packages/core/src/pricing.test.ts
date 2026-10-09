import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './config.js';
import {
  computeLlmCost,
  estimateMaxLlmCost,
  loadPricing,
  parsePricing,
  unpricedModels,
} from './pricing.js';

const pricing = loadPricing(path.join(findRepoRoot(), 'config', 'model-pricing.json'));
const usage = (u: Partial<Parameters<typeof computeLlmCost>[2]>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...u,
});

describe('pricing', () => {
  it('loads the repo pricing file with the default models', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(pricing.models[m], m).toBeDefined();
    }
  });

  it('prices input, output and cache tokens per 1M', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write (5m)
    const c = computeLlmCost(
      pricing,
      'claude-sonnet-5-5',
      usage({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWrite5mTokens: 200_000,
      }),
    );
    expect(c).toEqual({ usd: 2 + 1 + 0.1 + 0.5, estimated: false });
  });

  it('Opus 5.5 costs $4/$20', () => {
    expect(
      computeLlmCost(pricing, 'claude-opus-5-5', usage({ inputTokens: 1000, outputTokens: 1000 }))
        .usd,
    ).toBe(0.024);
  });

  it('switches Haiku to long-context rates above the threshold', () => {
    const short = computeLlmCost(pricing, 'claude-haiku-5-5', usage({ inputTokens: 100_000 }));
    const long = computeLlmCost(pricing, 'claude-haiku-5-5', usage({ inputTokens: 100_001 }));
    expect(short.usd).toBeCloseTo(0.01, 8);
    expect(long.usd).toBeCloseTo(0.0500005, 8);
  });

  it('unknown model -> most expensive known rates, marked estimated', () => {
    const c = computeLlmCost(pricing, 'claude-something-new', usage({ outputTokens: 1_000_000 }));
    expect(c.estimated).toBe(true);
    expect(c.usd).toBe(50);
  });

  it('worst-case estimate is never below the real cost of the same call', () => {
    const est = estimateMaxLlmCost(pricing, 'claude-opus-5-5', 3000, 2000);
    const real = computeLlmCost(
      pricing,
      'claude-opus-5-5',
      usage({ inputTokens: 3000, outputTokens: 2000 }),
    ).usd;
    expect(est).toBeGreaterThanOrEqual(real);
  });

  it('rejects a malformed pricing file', () => {
    expect(() => parsePricing({ currency: 'USD', verifiedAt: 'x', models: {} })).toThrow();
    expect(() => parsePricing({ currency: 'EUR', verifiedAt: 'x', models: { a: {} } })).toThrow();
  });

  it('gateway price list: the free model costs 0 and is known; unknown models are expensive', () => {
    const gw = loadPricing(path.join(findRepoRoot(), 'config', 'model-pricing.tokenharbor.json'));
    const big = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(computeLlmCost(gw, 'claude-haiku-5.5:free', big)).toEqual({ usd: 0, estimated: false });
    const unknown = computeLlmCost(gw, 'claude-opus-5-5', big);
    expect(unknown.estimated).toBe(true);
    expect(unknown.usd).toBe(60); // unknownModelRates: $10 in + $50 out
    expect(unpricedModels(gw, ['claude-haiku-5.5:free', 'x', 'x'])).toEqual(['x']);
  });
});
