import { errorToJson, type Actor, type AppConfig, type Logger, type ModelPricing } from '@cms/core';
import { schema, type Db } from '@cms/db';
import { LlmClient, createTask } from '@cms/engine';
import { runCeo } from './agents/ceo.js';
import type { AgentContext } from './agents/context.js';
import { runCopywriter } from './agents/copywriter.js';
import { runCritic } from './agents/critic.js';
import { getBrand } from './brand.js';
import type { AgentControls } from './controls.js';
import { MockImageProvider, type ObjectStorage } from '@cms/providers';
import { imageExecutor } from './agents/image.js';
import { kpExecutor } from './agents/kp.js';
import { MockLlmTransport } from './mock-llm.js';
import {
  normalizePromptText,
  promptHash,
  promptLabel,
  validatePromptText,
  type PromptMap,
} from './prompts.js';
import {
  constructorSpecOf,
  needsFields,
  recordAgentTest,
  specHashOf,
  usesLlm,
} from './agent-registry.js';
import { ConstructorSpec, constructorExecutor } from './constructor.js';
import { capabilityById } from './capabilities.js';
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
const SAMPLE_KP_BRIEF =
  'Кофейня «Зерно» хочет вести Instagram и Telegram: контент-план на месяц, 8 постов и 2 Reels.';
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

/** The writer of sample texts for tests of agents that work on texts (not an agent). */
const SAMPLE_WRITER = { id: 'sample_writer', name: 'Тексты (пример)' };

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
  if (!ref) return fail('Нет такого агента');
  if (opts.promptText != null) {
    const problem = validatePromptText(opts.promptText);
    if (problem) return fail(problem);
  }
  let spec: ConstructorSpec | null = null;
  if (needsFields(ref)) {
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
  if (draft && ref.promptAgent) {
    const text = normalizePromptText(opts.promptText!);
    prompts[ref.promptAgent] = {
      agent: ref.promptAgent,
      text,
      version: promptLabel(ref.promptAgent, 'draft', promptHash(text)),
    };
  }
  const callsLlm = usesLlm(ref);
  const prompt = ref.promptAgent ? prompts[ref.promptAgent] : undefined;
  if (callsLlm && !prompt)
    return fail('Сначала сохраните промпт агента (или напишите его в редакторе)');
  // Sample texts for agents that work on texts (reviewer, image, fields): a throwaway writer.
  prompts[SAMPLE_WRITER.id] = {
    agent: SAMPLE_WRITER.id,
    text: 'Пиши тексты для постов бренда.',
    version: 'sample-writer@test',
  };
  const self = { id: ref.id, name: ref.name };

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
  const promptVersion = prompt?.version ?? `${ref.id}@tool`;
  const model = ref.modelRole ? (agentModels[ref.id] ?? models[ref.modelRole]) : 'tool';
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
  const record = !draft && opts.spec == null;
  const finish = async (ok: boolean, message: string) => {
    if (record)
      await recordAgentTest(d.db, brandId, ref.id, {
        ok,
        at: new Date().toISOString(),
        message,
        specHash: specHashOf(ref),
        promptVersion,
      });
  };
  const sampleCopy = async () => (await runCopywriter(ctx, copyInput, SAMPLE_WRITER)).output.items;
  try {
    let output: unknown;
    const sampleUpstream = async (): Promise<NodeInput> => ({
      brief: SAMPLE_BRIEF,
      plan: SAMPLE_PLAN,
      upstream: [{ agent: SAMPLE_WRITER.id, name: 'Тексты (пример)', items: await sampleCopy() }],
      previous: null,
      ownerComment: null,
      criticIssues: [],
      mode: 'first',
      step: 'test',
    });
    if (spec) {
      const nodeInput = await sampleUpstream();
      input = { brief: SAMPLE_BRIEF, plan: SAMPLE_PLAN.summary, upstream: 'Тексты (пример)' };
      const exec = constructorExecutor({ id: ref.id, name: ref.name, role: ref.role, spec });
      output = (await exec.run(ctx, nodeInput)).output;
      render = exec.render(output);
      review = (await exec.review!(ctx, nodeInput, output, self)).output;
    } else if (ref.teamRole === 'planner') {
      input = { brief: SAMPLE_BRIEF };
      output = (await runCeo(ctx, { brief: SAMPLE_BRIEF }, self)).output;
    } else if (ref.teamRole === 'reviewer') {
      const items = await sampleCopy();
      input = { brief: SAMPLE_BRIEF, items };
      output = (
        await runCritic(
          ctx,
          { brief: SAMPLE_BRIEF, deliverables: SAMPLE_DELIVERABLES, items, step: 'test' },
          self,
        )
      ).output;
    } else if (ref.capability === 'copywriting') {
      input = copyInput;
      output = (await runCopywriter(ctx, copyInput, self)).output;
    } else if (ref.capability === 'image_generate') {
      // Mock image generator and in-memory storage: free, nothing is kept.
      const nodeInput = await sampleUpstream();
      input = { brief: SAMPLE_BRIEF, plan: SAMPLE_PLAN.summary, upstream: 'Тексты (пример)' };
      const exec = imageExecutor({
        db: d.db,
        provider: new MockImageProvider(),
        storage: memoryStorage(),
        budget: { config: d.config.budget, timeZone: d.config.timezone },
        estimateUsd: 0,
        self,
      });
      output = (await exec.run(ctx, nodeInput)).output;
      render = exec.render(output);
      review = (await exec.review!(ctx, nodeInput, output, self)).output;
    } else if (ref.capability === 'kp_draft') {
      input = { brief: SAMPLE_KP_BRIEF, catalog: d.config.kp.catalogFile };
      const nodeInput: NodeInput = {
        brief: SAMPLE_KP_BRIEF,
        plan: SAMPLE_PLAN,
        upstream: [],
        previous: null,
        ownerComment: null,
        criticIssues: [],
        mode: 'first',
        step: 'test',
      };
      const exec = kpExecutor({
        catalogFile: d.config.kp.catalogFile,
        vatPercent: d.config.kp.vatPercent,
        self,
      });
      output = (await exec.run(ctx, nodeInput)).output;
      render = exec.render(output);
      review = (await exec.review!(ctx, nodeInput, output, self)).output;
    } else if (!callsLlm) {
      // A tool capability: code without a model. Its guards (permissions, mock by default,
      // a gate before irreversible actions) are checked by its own tests; here nothing to call.
      const cap = capabilityById(ref.capability);
      input = { capability: ref.capability };
      output = { tool: cap?.name ?? ref.capability, model: 'нет (инструмент)' };
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

/** Throwaway storage for test runs (images of a test are not kept). */
function memoryStorage(): ObjectStorage {
  const m = new Map<string, Buffer>();
  return {
    name: 'memory',
    put: (key, body, contentType) => {
      m.set(key, body);
      return Promise.resolve({ key, size: body.length, contentType });
    },
    get: (key) => Promise.resolve(m.get(key) ?? Buffer.alloc(0)),
    exists: (key) => Promise.resolve(m.has(key)),
    delete: (key) => Promise.resolve(void m.delete(key)),
    healthCheck: () => Promise.resolve(),
  };
}
