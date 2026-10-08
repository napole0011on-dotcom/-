/**
 * First real Claude API call with a hard spending limit.
 *   pnpm smoke:llm
 * Needs ANTHROPIC_API_KEY in .env and a migrated database (pnpm infra:up && pnpm db:migrate).
 * The call is made inside a throwaway task whose budget is SMOKE_LIMIT_USD; the budget
 * reservation refuses the call up front if its worst case could exceed the limit.
 */
import { z } from 'zod';
import {
  BudgetExceededError,
  ConfigError,
  createLogger,
  loadConfig,
  loadDotEnv,
  loadPricing,
} from '@cms/core';
import { createDb, createPool, schema, sql } from '@cms/db';
import {
  LlmClient,
  budgetStatus,
  createAnthropicTransport,
  createTask,
  transitionTask,
} from '@cms/engine';
import { MockNotifier } from '@cms/providers';
import { loadBrandProfileFile, upsertBrand } from '@cms/agents';

const SMOKE_LIMIT_USD = 0.02;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  if (!config.llm.apiKey) {
    throw new ConfigError(['ANTHROPIC_API_KEY: is required for pnpm smoke:llm (add it to .env)']);
  }
  const logger = createLogger({ level: 'warn', name: 'smoke' });
  const pool = createPool(config.db, { max: 2 });
  const db = createDb(pool);
  try {
    const { brand } = await upsertBrand(db, loadBrandProfileFile(config.brandProfileFile));
    const actor = { kind: 'human', id: 'smoke' } as const;
    const { id: taskId } = await createTask(db, {
      brandId: brand.id,
      kind: 'smoke',
      title: 'Smoke test: first real API call',
      budgetUsd: SMOKE_LIMIT_USD,
      actor,
    });
    const budget = { config: config.budget, timeZone: config.timezone };
    const llm = new LlmClient({
      db,
      transport: createAnthropicTransport(config.llm),
      pricing: loadPricing(config.llm.pricingFile),
      config: { ...config.llm, maxRetries: 1 },
      budget,
      notifier: new MockNotifier(),
      logger,
    });

    const model = config.llm.models.worker;
    console.log(`Model: ${model}. Hard limit for this test: $${SMOKE_LIMIT_USD}.`);
    try {
      const r = await llm.callStructured({
        ctx: { brandId: brand.id, taskId, runId: null, agent: 'smoke', promptVersion: 'smoke@1' },
        model,
        system: [{ text: 'Ты помощник. Отвечай по-русски, очень коротко.' }],
        prompt:
          'Придумай одну короткую дружелюбную фразу-приветствие для подписчиков кофейни и посчитай в ней слова.',
        schema: z.object({
          greeting: z.string().min(5).max(200),
          wordCount: z.number().int().min(1),
        }),
        maxTokens: 600,
        effort: 'low',
        idempotencyKey: `smoke:${taskId}`,
      });
      const calls = await db
        .select()
        .from(schema.llmCalls)
        .where(sql`${schema.llmCalls.taskId} = ${taskId}`);
      const status = (await budgetStatus(db, budget, brand.id, taskId)).find(
        (s) => s.scope === 'task',
      )!;
      console.log('\nAnswer:', r.output);
      console.log(`Served by: ${r.servedModel}, attempts: ${r.attempts}`);
      for (const c of calls) {
        console.log(
          `  call #${c.attempt}: status=${c.status} in=${c.inputTokens} out=${c.outputTokens} cacheRead=${c.cacheReadTokens} cost=$${Number(c.costUsd).toFixed(6)} latency=${c.latencyMs}ms`,
        );
      }
      console.log(
        `\nACTUAL COST: $${r.costUsd.toFixed(6)} (limit $${SMOKE_LIMIT_USD}, task total $${status.spentUsd.toFixed(6)})`,
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(
          `Refused before calling the API: worst case $${err.requestedUsd.toFixed(4)} would exceed the $${SMOKE_LIMIT_USD} limit. Nothing was spent.`,
        );
      } else throw err;
    } finally {
      await transitionTask(db, {
        taskId,
        to: 'cancelled',
        actor: { kind: 'system', id: 'smoke' },
        reason: 'smoke test finished',
      });
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
