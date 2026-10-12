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
  type PromptMap,
} from './prompts.js';
import { constructorSpecOf, recordAgentTest } from './agent-registry.js';
import { ConstructorSpec, constructorExecutor, specHash } from './constructor.js';
import type { GenericVerdict, NodeInput, NodeRender } from './nodes.js';
import type { CeoPlan, Deliverable } from './schemas.js';

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
  /** Constructor agents: the result as the owner will see it, and the Critic verdict. */
  render?: NodeRender | null;
  review?: GenericVerdict | null;
  /** True when the result was stored as the agent's last test (saved spec + active prompt). */
  recorded?: boolean;
}

export interface AgentTestDeps {
  db: Db;
  config: AppConfig;
  controls: AgentControls;
  logger: Logger;
}

const SAMPLE_PLAN: CeoPlan = {
  summary: 'Тестовый план: два текста про осеннее меню',
  assumptions: [],
  questions: [],
  deliverables: SAMPLE_DELIVERABLES,
  unsupported: [],
};

/**
 * "Тест" button: runs one agent on a sample input with the mock LLM ($0, no network), using
 * the active prompt or an unsaved draft from the editor. Allowed while the agent is paused.
 * Constructor agents get the sample plan and a sample Copywriter result as upstream data,
 * and the generic Critic checks the result by the agent's criteria. A test of the SAVED spec
 * with the ACTIVE prompt is stored as the agent's last test: activation requires a passed one.
 * The service task (kind agent_test) is hidden from the board; nothing goes to the owner chat.
 */
export async function runAgentTest(
  d: AgentTestDeps,
  brandId: string,
  agentId: string,
  opts: { promptText?: string | null; spec?: unknown },
  actor: Actor,
): Promise<AgentTestResult> {
  const ref = await d.controls.agent(brandId, agentId);
  const empty = { agent: agentId, promptVersion: null, model: null, latencyMs: 0, input: null };
  const fail = (message: string): AgentTestResult => ({
    ...empty,
    ok: false,
    message,
    output: null,
  });
  if (!ref?.promptAgent || !ref.modelRole) return fail('Нет такого агента');
  if (opts.promptText != null) {
    const problem = validatePromptText(opts.promptText);
    if (problem) return fail(problem);
  }
  let spec: ConstructorSpec | null = null;
  if (ref.kind === 'constructor') {
    if (opts.spec != null) {
      const parsed = ConstructorSpec.safeParse(opts.spec);
      if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Неверные поля');
      spec = parsed.data;
    } else spec = constructorSpecOf(ref).spec;
    if (!spec) return fail('Добавьте хотя бы одно поле результата');
  }

  const models = await d.controls.effectiveModels(brandId);
  const agentModels = await d.controls.agentModels(brandId);
  const prompts: PromptMap = { ...(await d.controls.prompts(brandId)) };
  const draft = opts.promptText != null;
  if (draft) {
    const text = normalizePromptText(opts.promptText!);
    prompts[ref.promptAgent] = {
      agent: ref.promptAgent,
      text,
      version: promptLabel(ref.promptAgent, 'draft', promptHash(text)),
    };
  }
  const prompt = prompts[ref.promptAgent];
  if (!prompt) return fail('Сначала сохраните промпт агента (или напишите его в редакторе)');

  const { id: taskId } = await createTask(d.db, {
    brandId,
    kind: TEST_TASK_KIND,
    title: `Тест агента ${ref.name}`,
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
    agentModels,
    brand: await getBrand(d.db, brandId),
    taskId,
    runId: null,
    callKey: `agent-test:${taskId}`,
  };
  const promptVersion = prompt.version;
  const model = ref.code ? models[ref.modelRole] : (agentModels[ref.id] ?? models[ref.modelRole]);
  const started = Date.now();
  const copyInput = {
    brief: SAMPLE_BRIEF,
    planSummary: SAMPLE_PLAN.summary,
    deliverables: SAMPLE_DELIVERABLES,
    step: 'test',
  };
  let input: unknown = null;
  let render: NodeRender | null = null;
  let review: GenericVerdict | null = null;
  // Only a test of what is saved counts for activation (not a draft from the editor).
  const record = spec !== null && !draft && opts.spec == null;
  const finish = async (ok: boolean, message: string) => {
    if (record)
      await recordAgentTest(d.db, brandId, ref.id, {
        ok,
        at: new Date().toISOString(),
        message,
        specHash: specHash(spec!),
        promptVersion,
      });
  };
  try {
    let output: unknown;
    if (spec) {
      const copy = await runCopywriter(ctx, copyInput);
      const nodeInput: NodeInput = {
        brief: SAMPLE_BRIEF,
        plan: SAMPLE_PLAN,
        upstream: [{ agent: 'copywriter', name: 'Копирайтер', items: copy.output.items }],
        previous: null,
        ownerComment: null,
        criticIssues: [],
        mode: 'first',
        step: 'test',
      };
      input = { brief: SAMPLE_BRIEF, plan: SAMPLE_PLAN.summary, upstream: 'Копирайтер (пример)' };
      const exec = constructorExecutor({ id: ref.id, name: ref.name, role: ref.role, spec });
      output = (await exec.run(ctx, nodeInput)).output;
      render = exec.render(output);
      review = (await exec.review!(ctx, nodeInput, output)).output;
    } else if (ref.id === 'ceo') {
      input = { brief: SAMPLE_BRIEF };
      output = (await runCeo(ctx, { brief: SAMPLE_BRIEF })).output;
    } else if (ref.id === 'copywriter') {
      input = copyInput;
      output = (await runCopywriter(ctx, copyInput)).output;
    } else if (ref.id === 'critic') {
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
    } else {
      return fail(`Для агента ${ref.name} тест пока не настроен`);
    }
    const latencyMs = Date.now() - started;
    const message = `Тест прошёл за ${(latencyMs / 1000).toFixed(1)} с (mock-модель, $0)`;
    await finish(true, message);
    await audit(d.db, brandId, actor, { agent: ref.id, promptVersion, model, ok: true, taskId });
    return {
      ok: true,
      message,
      agent: ref.id,
      promptVersion,
      model,
      latencyMs,
      input,
      output,
      render,
      review,
      recorded: record,
    };
  } catch (err) {
    const info = errorToJson(err);
    const message = `Тест не прошёл: ${String(info.message)}`;
    await finish(false, message);
    await audit(d.db, brandId, actor, { agent: ref.id, promptVersion, model, ok: false, taskId });
    return {
      ok: false,
      message,
      agent: ref.id,
      promptVersion,
      model,
      latencyMs: Date.now() - started,
      input,
      output: null,
      recorded: record,
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
