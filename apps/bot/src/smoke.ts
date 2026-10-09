/**
 * First real LLM call(s) with a hard spending limit, through the provider from .env
 * (LLM_PROVIDER=anthropic or tokenharbor).
 *   pnpm smoke:llm
 * Needs the provider key in .env and a migrated database (pnpm infra:up && pnpm db:migrate).
 *
 * Two identical requests are sent: the second shows whether the provider reports prompt
 * cache reads (cache_read_input_tokens). Both run inside a throwaway task whose budget is
 * SMOKE_LIMIT_USD; a call is refused up front if its worst case could exceed the limit.
 */
import { z } from 'zod';
import {
  BudgetExceededError,
  ConfigError,
  createLogger,
  loadConfig,
  loadDotEnv,
  loadPricing,
  unpricedModels,
} from '@cms/core';
import { createDb, createPool, schema, sql } from '@cms/db';
import {
  LlmClient,
  budgetStatus,
  createLlmTransport,
  createTask,
  transitionTask,
} from '@cms/engine';
import { MockNotifier } from '@cms/providers';
import { copywriterSystem, getBrand, loadBrandProfileFile, upsertBrand } from '@cms/agents';

const SMOKE_LIMIT_USD = 0.02;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  if (config.llm.provider === 'mock') {
    throw new ConfigError([
      'LLM_PROVIDER: set it to anthropic or tokenharbor for pnpm smoke:llm (mock makes no API calls)',
    ]);
  }
  const logger = createLogger({ level: 'warn', name: 'smoke' });
  const pool = createPool(config.db, { max: 2 });
  const db = createDb(pool);
  const pricing = loadPricing(config.llm.pricingFile);
  const model = config.llm.models.worker;
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
      transport: createLlmTransport(config.llm),
      pricing,
      config: config.llm,
      budget,
      notifier: new MockNotifier(),
      logger,
    });

    console.log(
      `Provider: ${config.llm.provider}${config.llm.baseUrl ? ` (${config.llm.baseUrl}, auth ${config.llm.authMode})` : ''}`,
    );
    console.log(`Model (LLM_MODEL_WORKER): ${model}`);
    console.log(
      `Structured outputs: ${config.llm.structuredOutputs ? 'on' : 'off (schema in prompt, Zod validation)'}`,
    );
    console.log(
      `Price list: ${config.llm.pricingFile}${unpricedModels(pricing, [model]).length ? ' — MODEL NOT LISTED, priced as unknown' : ''}`,
    );
    console.log(
      `Hard limit for this test: $${SMOKE_LIMIT_USD}, safety factor x${config.llm.costSafetyFactor}\n`,
    );

    // A real agent system prompt (copywriter + brand profile, cached) so the prompt is long enough to cache.
    const agentCtx = {
      llm,
      models: config.llm.models,
      brand: await getBrand(db, brand.id),
      taskId,
      runId: null,
      callKey: `smoke:${taskId}`,
    };
    const { system } = copywriterSystem(agentCtx);
    const schemaOut = z.object({
      greeting: z.string().min(5).max(300),
      wordCount: z.number().int().min(1),
    });

    try {
      for (const n of [1, 2]) {
        const r = await llm.callStructured({
          ctx: { brandId: brand.id, taskId, runId: null, agent: 'smoke', promptVersion: 'smoke@2' },
          model,
          system,
          prompt:
            'Вместо обычной задачи: придумай одну короткую дружелюбную фразу-приветствие для подписчиков и посчитай в ней слова.',
          schema: schemaOut,
          maxTokens: 800,
          effort: 'low',
          idempotencyKey: `smoke:${taskId}:${n}`,
        });
        console.log(`Request ${n}: answer =`, r.output);
        console.log(
          `  served by ${r.servedModel}, attempts ${r.attempts}, cost $${r.rawCostUsd.toFixed(6)} (budgeted $${r.costUsd.toFixed(6)})`,
        );
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(
          `Stopped before calling the API: worst case $${err.requestedUsd.toFixed(4)} would exceed the $${SMOKE_LIMIT_USD} limit. Nothing more was spent.`,
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

    const calls = await db
      .select()
      .from(schema.llmCalls)
      .where(sql`${schema.llmCalls.taskId} = ${taskId}`)
      .orderBy(schema.llmCalls.createdAt);
    console.log('\nUsage as reported by the provider:');
    for (const c of calls) {
      const usage =
        (c.response as { usage?: unknown } | null)?.usage ??
        '(not stored: LLM_STORE_FULL_TEXT=false)';
      console.log(
        `  call ${calls.indexOf(c) + 1}: status=${c.status} in=${c.inputTokens} out=${c.outputTokens} cacheRead=${c.cacheReadTokens} cacheWrite=${c.cacheWriteTokens} cost=$${Number(c.costUsd).toFixed(6)} latency=${c.latencyMs}ms`,
      );
      console.log(`    raw usage: ${JSON.stringify(usage)}`);
    }
    const cacheRead = calls.some((c) => c.cacheReadTokens > 0);
    console.log(
      cacheRead
        ? '\nPrompt cache: cache_read_input_tokens > 0 on a real response — caching works through this provider.'
        : '\nPrompt cache: NOT confirmed — no cache_read_input_tokens on these responses (provider may not cache or not report it).',
    );
    const status = (await budgetStatus(db, budget, brand.id, taskId)).find(
      (s) => s.scope === 'task',
    )!;
    console.log(
      `ACTUAL COST (task total, with safety factor): $${status.spentUsd.toFixed(6)} of $${SMOKE_LIMIT_USD}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
