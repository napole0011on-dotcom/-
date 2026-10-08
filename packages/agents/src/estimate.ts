import { computeLlmCost, type LlmConfig, type ModelPricing } from '@cms/core';
import type { CeoPlan } from './schemas.js';

export interface PlanEstimate {
  /** Typical cost: one draft + half a revision round on average. */
  expectedUsd: number;
  /** Worst case within the rules: draft + 2 critic revisions. */
  maxUsd: number;
  expectedMinutes: number;
  steps: { agent: string; what: string }[];
}

// Rough token budgets per deliverable, measured on prompt sizes of these agents.
const SYSTEM_TOKENS = 2500;
const COPY_OUT_PER_ITEM = 1800; // 3 variants (+ script/slides) incl. adaptive thinking
const CRITIC_IN_PER_ITEM = 1200;
const CRITIC_OUT_PER_ITEM = 900;

export function estimatePlan(
  plan: CeoPlan,
  pricing: ModelPricing,
  models: LlmConfig['models'],
): PlanEstimate {
  const n = plan.deliverables.length;
  const round = (items: number) =>
    computeLlmCost(pricing, models.worker, {
      inputTokens: 600 * items + 400,
      outputTokens: COPY_OUT_PER_ITEM * items,
      cacheReadTokens: SYSTEM_TOKENS,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    }).usd +
    computeLlmCost(pricing, models.critic, {
      inputTokens: CRITIC_IN_PER_ITEM * items + 400,
      outputTokens: CRITIC_OUT_PER_ITEM * items,
      cacheReadTokens: SYSTEM_TOKENS,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    }).usd;
  const first =
    round(n) +
    computeLlmCost(pricing, models.worker, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: SYSTEM_TOKENS * 2,
      cacheWrite1hTokens: 0,
    }).usd;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    expectedUsd: r2(first + 0.5 * round(n)),
    maxUsd: r2(first + 2 * round(n)),
    expectedMinutes: Math.ceil(1 + n * 0.7),
    steps: [
      { agent: 'copywriter', what: `тексты: ${n} шт., по 3 варианта` },
      { agent: 'critic', what: 'проверка каждого текста, до 2 доработок' },
      { agent: 'ceo', what: 'сборка пакета и отправка вам на согласование' },
    ],
  };
}
