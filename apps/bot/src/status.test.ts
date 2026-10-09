import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, loadConfig, loadPricing } from '@cms/core';
import { describeLlmSetup } from './status.js';

const base = { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd' };
const root = findRepoRoot();

describe('startup greeting: active provider and models', () => {
  it('Token Harbor with the free model on every role', () => {
    const free = 'claude-haiku-5.5:free';
    const config = loadConfig(
      {
        ...base,
        LLM_PROVIDER: 'tokenharbor',
        TOKENHARBOR_API_KEY: 'k',
        TOKENHARBOR_BASE_URL: 'https://tokenharbor.ai',
        LLM_MODEL_CEO: free,
        LLM_MODEL_CRITIC: free,
        LLM_MODEL_WORKER: free,
        LLM_MODEL_CLASSIFIER: free,
        LLM_STRUCTURED_OUTPUTS: 'false',
        LLM_RATE_LIMIT_PER_MINUTE: '60',
        LLM_RATE_LIMIT_PER_HOUR: '1800',
      },
      root,
    );
    const text = describeLlmSetup(config, loadPricing(config.llm.pricingFile));
    expect(text).toMatch(/LLM: Token Harbor \(шлюз\)/);
    expect(text).toMatch(/Адрес шлюза: tokenharbor\.ai/);
    expect(text).toMatch(
      /CEO — claude-haiku-5\.5:free; Copywriter — claude-haiku-5\.5:free; Critic — claude-haiku-5\.5:free/,
    );
    expect(text).toMatch(/Structured outputs: нет/);
    expect(text).toMatch(/60\/мин, 1800\/час/);
    expect(text).toMatch(/Бесплатные модели: claude-haiku-5\.5:free/);
    expect(text).not.toMatch(/Нет цены/);
    expect(text).not.toContain('k\n');
  });

  it('warns when a configured model has no price', () => {
    const config = loadConfig(
      {
        ...base,
        LLM_PROVIDER: 'tokenharbor',
        TOKENHARBOR_API_KEY: 'k',
        TOKENHARBOR_BASE_URL: 'https://tokenharbor.ai',
      },
      root,
    );
    expect(describeLlmSetup(config, loadPricing(config.llm.pricingFile))).toMatch(
      /⚠️ Нет цены в model-pricing\.tokenharbor\.json: claude-opus-5-5, claude-sonnet-5-5/,
    );
  });

  it('mock mode says so', () => {
    const config = loadConfig(base, root);
    const pricing = loadPricing(path.join(root, 'config', 'model-pricing.json'));
    expect(describeLlmSetup(config, pricing)).toMatch(/LLM: mock/);
  });
});
