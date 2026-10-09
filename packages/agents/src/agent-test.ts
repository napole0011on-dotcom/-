import { errorToJson, type Actor, type AppConfig, type Logger, type ModelPricing } from '@cms/core';
import { schema, type Db } from '@cms/db';
import { LlmClient, createTask } from '@cms/engine';
import { runCeo } from './agents/ceo.js';
import type { AgentContext } from './agents/context.js';
import { runCopywriter } from './agents/copywriter.js';
import { runCritic } from './agents/critic.js';
import { getBrand } from './brand.js';
import type { AgentControls } from './controls.js';
import { MockLlmTransport } from './mock-llm.js';
import {
  normalizePromptText,
  promptHash,
  promptLabel,
  validatePromptText,
  type LoadedPrompt,
} from './prompts.js';
import { agentById } from './registry.js';
import type { Deliverable } from './schemas.js';

/** Test runs are free: every model is priced at zero. */
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const ZERO_PRICING: ModelPricing = {
  currency: 'USD',
  verifiedAt: 'mock',
  unknownModelRates: ZERO,
  models: { mock: ZERO },
};

export const TEST_TASK_KIND = 'agent_test';

const SAMPLE_BRIEF =
  'Тестовый запуск: пост для Instagram и пост для Telegram про осеннее меню кофейни';
const SAMPLE_DELIVERABLES: Deliverable[] = [
  {
    id: 'post-1',
    platform: 'instagram_post',
    topic: 'Осеннее меню кофейни',
    goal: 'сохранения',
    notes: '',
  },
  {
    id: 'tg-1',
    platform: 'telegram_post',
    topic: 'Осеннее меню подробнее',
    goal: 'вовлечение',
    notes: '',
  },
];

export interface AgentTestResult {
  ok: boolean;
  message: string;
  agent: string;
  promptVersion: string | null;
  model: string | null;
  latencyMs: number;
  input: unknown;
  output: unknown;
}

export interface AgentTestDeps {
  db: Db;
  config: AppConfig;
  controls: AgentControls;
  logger: Logger;
}

/**
 * "Тест" button: runs one agent on a sample input with the mock LLM ($0, no network), using
 * the active prompt or an unsaved draft from the editor. Allowed while the agent is paused.
 * The service task (kind agent_test) is hidden from the board; nothing goes to the owner chat.
 */
export async function runAgentTest(
  d: AgentTestDeps,
  brandId: string,
  agentId: string,
  opts: { promptText?: string | null },
  actor: Actor,
): Promise<AgentTestResult> {
  const def = agentById(agentId);
  const empty = { agent: agentId, promptVersion: null, model: null, latencyMs: 0, input: null };
  if (!def) return { ...empty, ok: false, message: 'Нет такого агента', output: null };
  if (opts.promptText != null) {
    const problem = validatePromptText(opts.promptText);
    if (problem) return { ...empty, ok: false, message: problem, output: null };
  }

  const models = await d.controls.effectiveModels(brandId);
  const prompts: Record<string, LoadedPrompt> = { ...(await d.controls.prompts(brandId)) };
  if (opts.promptText != null) {
    const text = normalizePromptText(opts.promptText);
    prompts[def.prompt] = {
      agent: def.prompt,
      text,
      version: promptLabel(def.prompt, 'draft', promptHash(text)),
    };
  }
  const { id: taskId } = await createTask(d.db, {
    brandId,
    kind: TEST_TASK_KIND,
    title: `Тест агента ${def.name}`,
    brief: { text: SAMPLE_BRIEF },
    budgetUsd: d.config.budget.taskUsd,
    actor,
  });
  const llm = new LlmClient({
    db: d.db,
    transport: new MockLlmTransport(),
    pricing: ZERO_PRICING,
    // The mock answers by the output schema, so structured outputs are always on here.
    config: { ...d.config.llm, structuredOutputs: true, refusalFallback: false },
    budget: { config: d.config.budget, timeZone: d.config.timezone },
    notifier: { name: 'none', send: () => Promise.resolve({ messageId: 'none' }) },
    logger: d.logger,
  });
  const ctx: AgentContext = {
    llm,
    models,
    prompts,
    brand: await getBrand(d.db, brandId),
    taskId,
    runId: null,
    callKey: `agent-test:${taskId}`,
  };
  const promptVersion = prompts[def.prompt]!.version;
  const model = models[def.modelRole];
  const started = Date.now();
  const copyInput = {
    brief: SAMPLE_BRIEF,
    planSummary: 'Тестовый план: два текста про осеннее меню',
    deliverables: SAMPLE_DELIVERABLES,
    step: 'test',
  };
  let input: unknown = null;
  try {
    let output: unknown;
    if (def.id === 'ceo') {
      input = { brief: SAMPLE_BRIEF };
      output = (await runCeo(ctx, { brief: SAMPLE_BRIEF })).output;
    } else if (def.id === 'copywriter') {
      input = copyInput;
      output = (await runCopywriter(ctx, copyInput)).output;
    } else {
      const copy = await runCopywriter(ctx, copyInput);
      input = { brief: SAMPLE_BRIEF, items: copy.output.items };
      output = (
        await runCritic(ctx, {
          brief: SAMPLE_BRIEF,
          deliverables: SAMPLE_DELIVERABLES,
          items: copy.output.items,
          step: 'test',
        })
      ).output;
    }
    const latencyMs = Date.now() - started;
    await audit(d.db, brandId, actor, { agent: def.id, promptVersion, model, ok: true, taskId });
    return {
      ok: true,
      message: `Тест прошёл за ${(latencyMs / 1000).toFixed(1)} с (mock-модель, $0)`,
      agent: def.id,
      promptVersion,
      model,
      latencyMs,
      input,
      output,
    };
  } catch (err) {
    const info = errorToJson(err);
    await audit(d.db, brandId, actor, { agent: def.id, promptVersion, model, ok: false, taskId });
    return {
      ok: false,
      message: `Тест не прошёл: ${String(info.message)}`,
      agent: def.id,
      promptVersion,
      model,
      latencyMs: Date.now() - started,
      input,
      output: null,
    };
  }
}

async function audit(db: Db, brandId: string, actor: Actor, details: Record<string, unknown>) {
  await db.insert(schema.auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action: 'agent_test',
    details,
  });
}
