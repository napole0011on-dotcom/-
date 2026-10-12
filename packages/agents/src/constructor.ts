import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EXTERNAL_DATA_RULES, wrapExternalData } from '@cms/engine';
import type { AgentContext, AgentResult } from './agents/context.js';
import { json } from './agents/context.js';
import { renderBrandForPrompt } from './brand.js';
import type { GenericVerdict, NodeExecutor, NodeInput, NodeRender } from './nodes.js';
import { promptHash, promptLabel } from './prompts.js';

/**
 * Agents built in the panel ("конструктор"): an LLM call with the owner's system prompt and
 * an output made of simple typed fields. No tools, no side effects: input -> JSON by schema.
 */

export const FIELD_TYPES = ['text', 'long_text', 'list', 'number', 'boolean', 'items'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'строка',
  long_text: 'текст',
  list: 'список строк',
  number: 'число',
  boolean: 'да/нет',
  items: 'список объектов',
};

const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'ключ поля: латиница, цифры и _, с буквы, до 40 символов');

const SubField = z.object({
  key: fieldKey,
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'long_text', 'number', 'boolean']),
  hint: z.string().max(300).default(''),
});

export const OutputField = z.object({
  key: fieldKey,
  label: z.string().trim().min(1, 'нужно название поля').max(80),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  hint: z.string().max(300).default(''),
  /** list / items: at least this many entries. */
  minItems: z.number().int().min(0).max(20).optional(),
  /** items: fields of each object. */
  fields: z.array(SubField).max(10).optional(),
});
export type OutputField = z.infer<typeof OutputField>;

export const AgentTestRecord = z.object({
  ok: z.boolean(),
  at: z.string(),
  message: z.string(),
  specHash: z.string(),
  promptVersion: z.string(),
});
export type AgentTestRecord = z.infer<typeof AgentTestRecord>;

export const ConstructorSpec = z
  .object({
    fields: z.array(OutputField).min(1, 'нужно хотя бы одно поле результата').max(20),
    /** What the Critic checks when the board links this agent to the Critic. */
    criteria: z.array(z.string().trim().min(3).max(300)).max(15).default([]),
    lastTest: AgentTestRecord.nullable().default(null),
  })
  .superRefine((s, ctx) => {
    const keys = s.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'ключи полей должны быть разными',
      });
    s.fields.forEach((f, i) => {
      if (f.type === 'items' && !f.fields?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'fields'],
          message: `у поля «${f.label}» нужны вложенные поля`,
        });
    });
  });
export type ConstructorSpec = z.infer<typeof ConstructorSpec>;

/** Hash of what defines behaviour (fields + criteria): a test is valid only for this hash. */
export const specHash = (s: Pick<ConstructorSpec, 'fields' | 'criteria'>) =>
  createHash('sha256')
    .update(JSON.stringify({ fields: s.fields, criteria: s.criteria }))
    .digest('hex')
    .slice(0, 12);

function leaf(type: 'text' | 'long_text' | 'number' | 'boolean', hint: string) {
  const base =
    type === 'number' ? z.number() : type === 'boolean' ? z.boolean() : z.string().min(1);
  return hint ? base.describe(hint) : base;
}

/** Zod schema of the agent's result (all keys present; optional fields are nullable). */
export function outputSchema(agentId: string, fields: OutputField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let t: z.ZodType;
    if (f.type === 'list') {
      t = z.array(z.string().min(1)).min(f.minItems ?? (f.required ? 1 : 0));
    } else if (f.type === 'items') {
      const sub: Record<string, z.ZodType> = {};
      for (const s of f.fields ?? []) sub[s.key] = leaf(s.type, s.hint);
      t = z.array(z.object(sub)).min(f.minItems ?? (f.required ? 1 : 0));
    } else {
      t = leaf(f.type, '');
    }
    if (f.hint) t = t.describe(f.hint);
    shape[f.key] = f.required ? t : t.nullable();
  }
  return z.object(shape).meta({ title: `Agent_${agentId.replace(/[^a-zA-Z0-9_]/g, '_')}` });
}

const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Owner-facing lines: "Поле: значение", lists joined, objects one per line. */
export function renderBySpec(title: string, fields: OutputField[], output: unknown): NodeRender {
  const o = (output ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const f of fields) {
    const v = o[f.key];
    if (v === null || v === undefined || v === '') continue;
    if (f.type === 'list' && Array.isArray(v)) lines.push(`${f.label}: ${v.map(str).join(', ')}`);
    else if (f.type === 'items' && Array.isArray(v)) {
      lines.push(`${f.label}:`);
      for (const item of v as Record<string, unknown>[])
        lines.push(
          `• ${(f.fields ?? [])
            .map((s) => item[s.key])
            .filter((x) => x !== null && x !== undefined && x !== '')
            .map(str)
            .join(' — ')}`,
        );
    } else if (f.type === 'boolean') lines.push(`${f.label}: ${v ? 'да' : 'нет'}`);
    else lines.push(`${f.label}: ${str(v)}`);
  }
  return { title, lines };
}

export interface ConstructorAgentDef {
  id: string;
  name: string;
  role: string;
  spec: ConstructorSpec;
}

function taskPrompt(def: ConstructorAgentDef, input: NodeInput): string {
  const parts = [`Бриф владельца:\n${input.brief}`];
  parts.push(
    `План CEO: ${input.plan.summary}\nЕдиницы контента:\n${json(
      input.plan.deliverables.map((d) => ({ id: d.id, platform: d.platform, topic: d.topic })),
    )}`,
  );
  for (const u of input.upstream)
    parts.push(
      `Результат шага «${u.name}»:\n${wrapExternalData(`step:${u.agent}`, json(u.items))}`,
    );
  if (input.previous != null)
    parts.push(
      `Прошлая версия твоего результата:\n${wrapExternalData('previous', json(input.previous))}`,
    );
  if (input.ownerComment)
    parts.push(`Комментарий владельца (главное, учти обязательно):\n${input.ownerComment}`);
  if (input.criticIssues.length)
    parts.push(`Замечания проверяющего (исправь):\n${json(input.criticIssues)}`);
  if (input.mode === 'regenerate') parts.push('Сделай заново, с другим подходом.');
  parts.push(
    [
      `Твоя роль: ${def.role}.`,
      'Верни результат строго по схеме. Поля:',
      ...def.spec.fields.map(
        (f) =>
          `- ${f.key} (${FIELD_TYPE_LABEL[f.type]}${f.required ? '' : ', можно null'}): ${f.label}${f.hint ? ` — ${f.hint}` : ''}`,
      ),
    ].join('\n'),
  );
  return parts.join('\n\n');
}

export const GENERIC_CRITIC_PROMPT = [
  'Ты — независимый проверяющий в контент-команде. Тебе дают результат работы агента и критерии.',
  'Проверь результат строго по критериям и брифу. Не переписывай результат, только оцени.',
  'passed=true, только если все критерии выполнены. issues — конкретные проблемы и как исправить (до 7).',
  'summary — одна-две фразы для владельца, без воды.',
].join('\n');

const GenericReview = z
  .object({
    passed: z.boolean(),
    summary: z.string().min(3),
    issues: z.array(z.object({ problem: z.string().min(3), fix: z.string().min(3) })).max(7),
  })
  .meta({ title: 'GenericReview' });

export const GENERIC_CRITIC_VERSION = promptLabel(
  'critic-generic',
  1,
  promptHash(GENERIC_CRITIC_PROMPT),
);

/**
 * The Critic checking a non-copy result by the agent's criteria (constructor agents, Image, ...).
 * Without criteria: fits the brief and the agent's role, no invented facts.
 */
export async function genericReview(
  ctx: AgentContext,
  input: NodeInput,
  output: unknown,
  def: { id: string; name: string; role: string; criteria?: readonly string[] },
): Promise<AgentResult<GenericVerdict>> {
  const criteria = def.criteria?.length
    ? def.criteria
    : ['результат отвечает брифу и роли агента', 'нет выдуманных фактов, цифр и обещаний'];
  const r = await ctx.llm.callStructured({
    ctx: {
      brandId: ctx.brand.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agent: 'critic',
      promptVersion: GENERIC_CRITIC_VERSION,
    },
    model: ctx.models.critic,
    system: [
      { text: GENERIC_CRITIC_PROMPT, cache: true },
      { text: renderBrandForPrompt(ctx.brand), cache: true },
      { text: EXTERNAL_DATA_RULES },
    ],
    prompt: [
      `Бриф владельца:\n${input.brief}`,
      `Агент «${def.name}»: ${def.role}`,
      `Критерии проверки:\n${criteria.map((c) => `- ${c}`).join('\n')}`,
      `Результат агента:\n${wrapExternalData(`result:${def.id}`, json(output))}`,
    ].join('\n\n'),
    schema: GenericReview,
    maxTokens: 3000,
    effort: 'medium',
    idempotencyKey: `${ctx.callKey}:critic:${def.id}:${input.step}`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return {
    output: r.output,
    promptVersion: GENERIC_CRITIC_VERSION,
    model: r.servedModel,
    costUsd: r.costUsd,
  };
}

/** Executor for a constructor agent (and the Critic review of its result). */
export function constructorExecutor(def: ConstructorAgentDef): NodeExecutor {
  const schema = outputSchema(def.id, def.spec.fields);
  return {
    async run(ctx: AgentContext, input: NodeInput): Promise<AgentResult<unknown>> {
      const prompt = ctx.prompts[def.id];
      if (!prompt) throw new Error(`У агента ${def.name} нет активного промпта`);
      const model = ctx.agentModels[def.id] ?? ctx.models.worker;
      const r = await ctx.llm.callStructured({
        ctx: {
          brandId: ctx.brand.id,
          taskId: ctx.taskId,
          runId: ctx.runId,
          agent: def.id,
          promptVersion: prompt.version,
        },
        model,
        system: [
          { text: prompt.text, cache: true },
          { text: renderBrandForPrompt(ctx.brand), cache: true },
          { text: EXTERNAL_DATA_RULES },
        ],
        prompt: taskPrompt(def, input),
        schema,
        maxTokens: 6000,
        effort: 'medium',
        idempotencyKey: `${ctx.callKey}:${def.id}:${input.step}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        output: r.output,
        promptVersion: prompt.version,
        model: r.servedModel,
        costUsd: r.costUsd,
      };
    },
    render(output: unknown) {
      return renderBySpec('Результат', def.spec.fields, output);
    },
    review(ctx, input, output) {
      return genericReview(ctx, input, output, { ...def, criteria: def.spec.criteria });
    },
  };
}
