import type { LlmRequest, LlmResponse, LlmTransport } from '@cms/engine';
import type { CeoPlan, CopyItem, Deliverable, Review } from './schemas.js';

/**
 * LLM_PROVIDER=mock: canned, schema-valid answers for every agent, no network, $0.
 * Lets you click through the whole bot flow before spending anything.
 * The agent is recognised by the output schema title; inputs are read from the prompt.
 */
export class MockLlmTransport implements LlmTransport {
  calls = 0;

  create(params: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const schema = schemaOf(params);
    const title = schema?.title;
    const prompt = promptText(params);
    let body: unknown;
    if (title === 'CeoPlan') body = mockPlan(prompt);
    else if (title === 'CopywriterOutput') body = mockCopy(prompt);
    else if (title === 'CriticOutput') body = mockCritic(prompt);
    else if (title === 'ImageBriefs') body = mockImages(prompt);
    else if (title === 'KpDraft') body = mockKp(prompt);
    else body = schema ? mockFromSchema(schema) : {};
    return Promise.resolve({
      id: `mock_${this.calls}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        iterations: null,
      },
    } as unknown as LlmResponse);
  }
}

type JsonSchema = {
  title?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  minLength?: number;
  description?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};

/** The SDK moves constraints it cannot send into the description: "{minItems: 2}". */
const fromDescription = (s: JsonSchema, k: 'minItems' | 'maxItems' | 'minLength' | 'minimum') => {
  const m = new RegExp(`${k}:\\s*(-?\\d+)`).exec(s.description ?? '');
  return m ? Number(m[1]) : undefined;
};

/** The output schema: structured outputs, or the JSON Schema line of the schema-in-prompt mode. */
function schemaOf(params: LlmRequest): JsonSchema | undefined {
  const s = params.output_config?.format?.schema as JsonSchema | undefined;
  if (s) return s;
  const system = Array.isArray(params.system)
    ? params.system.map((b) => ('text' in b ? b.text : '')).join('\n')
    : (params.system ?? '');
  const m = /Формат ответа:[^\n]*\n[^\n]*\n(\{[\s\S]*\})\s*$/.exec(system);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!) as JsonSchema;
  } catch {
    return undefined;
  }
}

/**
 * A plausible, schema-valid answer for any agent without its own mock (constructor agents,
 * new code agents): strings marked [MOCK], numbers at the minimum, arrays at minItems (or 1).
 * Semantic checks (refinements) are the agent's own business.
 */
export function mockFromSchema(
  input: JsonSchema,
  key = 'value',
  depth = 0,
  root: JsonSchema = input,
): unknown {
  if (depth > 12) return null;
  const schema: JsonSchema = input.$ref
    ? { ...(root.$defs?.[input.$ref.replace('#/$defs/', '')] ?? {}), ...input, $ref: undefined }
    : input;
  if (schema !== input) return mockFromSchema(schema, key, depth + 1, root);
  const minItems = schema.minItems ?? fromDescription(schema, 'minItems');
  const maxItems = schema.maxItems ?? fromDescription(schema, 'maxItems');
  const minLength = schema.minLength ?? fromDescription(schema, 'minLength') ?? 0;
  const minimum = schema.minimum ?? fromDescription(schema, 'minimum');
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.length) {
    const nonNull = variants.find((v) => v.type !== 'null') ?? variants[0]!;
    return mockFromSchema(nonNull, key, depth + 1, root);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {}))
        out[k] = mockFromSchema(v, k, depth + 1, root);
      return out;
    }
    case 'array': {
      const n = Math.max(minItems ?? 1, 1);
      const len = maxItems !== undefined ? Math.min(n, maxItems) : n;
      return Array.from({ length: len }, (_, i) =>
        mockFromSchema(schema.items ?? { type: 'string' }, `${key} ${i + 1}`, depth + 1, root),
      );
    }
    case 'number':
    case 'integer':
      return minimum ?? 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default: {
      const text = `[MOCK] ${key}`;
      return text.length >= minLength ? text : text.padEnd(minLength, '.');
    }
  }
}

/** A KP that picks the first catalog positions (ids read from the catalog block of the prompt). */
function mockKp(prompt: string) {
  const block = prompt.split('Справочник услуг')[1]?.split('Библиотека кейсов')[0] ?? '';
  const ids = [...block.matchAll(/"id":\s*"([a-z0-9][a-z0-9_-]*)"/g)].map((m) => m[1]!);
  return {
    client: '[MOCK] Кофейня «Зерно»',
    intro:
      '[MOCK] Поняли задачу: нужен регулярный контент и понятный план. Предлагаем начать с плана и сценариев.',
    scope: ids.slice(0, 3).map((id, i) => ({
      item_id: id,
      qty: i === 1 ? 2 : 1,
      comment: '[MOCK] под задачу клиента',
    })),
    timeline: [
      { stage: 'План и согласование', duration: '3 дня' },
      { stage: 'Производство', duration: '2 недели' },
    ],
    assumptions: ['[MOCK] Материалы и доступы клиент даёт в первый день'],
    terms: '[MOCK] Оплата по этапам, порядок — по договору.',
    next_step: '[MOCK] Созвон на 30 минут, чтобы уточнить объём.',
    cases_used: [],
    warnings: [],
  };
}

/** Image briefs for the deliverables listed in the prompt (with the aspect the agent suggests). */
function mockImages(prompt: string) {
  const json = /Единицы контента:\n(\[[\s\S]*?\n\])/.exec(prompt)?.[1] ?? '[]';
  const items = JSON.parse(json) as { id: string; topic: string; aspect?: string }[];
  return {
    images: items.map((d) => ({
      deliverableId: d.id,
      prompt: `[MOCK] Warm autumn coffee shop scene for "${d.topic}", soft window light, no text`,
      alt: `[MOCK] Картинка к «${d.topic}»`,
      aspect: ['4:5', '9:16', '16:9'].includes(d.aspect ?? '') ? d.aspect : '4:5',
    })),
  };
}

function promptText(params: LlmRequest): string {
  const last = [...params.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string'
    ? last.content
    : last.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

function mockPlan(prompt: string): CeoPlan {
  const reels = /reels|рилс|ролик/i.test(prompt);
  const comment = /Комментарий владельца[^\n]*\n([^\n]+)/.exec(prompt)?.[1];
  const deliverables: Deliverable[] = [
    reels
      ? {
          id: 'reels-1',
          platform: 'instagram_reels',
          topic: 'Главная мысль брифа в коротком ролике',
          goal: 'охват',
          notes: '',
        }
      : {
          id: 'post-1',
          platform: 'instagram_post',
          topic: 'Главная мысль брифа',
          goal: 'сохранения',
          notes: '',
        },
    {
      id: 'tg-1',
      platform: 'telegram_post',
      topic: 'Та же тема подробнее для Telegram',
      goal: 'вовлечение',
      notes: '',
    },
  ];
  return {
    summary: `[MOCK] Копирайтер напишет ${deliverables.length} текста по брифу, критик проверит каждый.${comment ? ` Учтён комментарий: ${comment}` : ''}`,
    assumptions: ['[MOCK] ответ сгенерирован без LLM (LLM_PROVIDER=mock)'],
    questions: [],
    deliverables,
    unsupported: [],
  };
}

function mockCopy(prompt: string): { items: CopyItem[] } {
  const json = /<deliverables_json>([\s\S]*?)<\/deliverables_json>/.exec(prompt)?.[1] ?? '[]';
  const deliverables = JSON.parse(json) as Deliverable[];
  const comment = /Комментарий владельца \(главное\):\n([^\n]+)/.exec(prompt)?.[1];
  const fresh = /написать заново/.test(prompt);
  return {
    items: deliverables.map((d) => ({
      deliverableId: d.id,
      variants: [1, 2, 3].map((n) => ({
        angle: ['через боль', 'через историю', 'через пользу'][n - 1]!,
        hook: `[MOCK${fresh ? ', заново' : ''}] Вариант ${n}: ${d.topic}`.slice(0, 120),
        body: `Тестовый текст для «${d.topic}». Здесь будет живой текст от копирайтера.${comment ? `\nУчтено: ${comment}` : ''}`,
        cta: 'Сохрани, чтобы не потерять',
      })),
      slides: d.platform === 'instagram_carousel' ? ['Слайд 1', 'Слайд 2', 'Слайд 3'] : null,
      reelsScript:
        d.platform === 'instagram_reels'
          ? [
              {
                fromSec: 0,
                toSec: 3,
                visual: 'Крупный план',
                voiceover: 'Хук',
                onScreenText: 'Хватит листать',
              },
              {
                fromSec: 3,
                toSec: 15,
                visual: 'Демонстрация',
                voiceover: 'Суть',
                onScreenText: '3 шага',
              },
            ]
          : null,
    })),
  };
}

function mockCritic(prompt: string): { reviews: Review[] } {
  const ids = [...prompt.matchAll(/"deliverableId":\s*"([^"]+)"/g)].map((m) => m[1]!);
  const ok = { ok: true, comment: '[MOCK] ок' };
  return {
    reviews: [...new Set(ids)].map((id) => ({
      deliverableId: id,
      verdict: 'pass',
      checks: {
        briefFit: ok,
        brandVoice: ok,
        clichesAndBureaucratese: ok,
        facts: ok,
        lengthAndFormat: ok,
      },
      issues: [],
      summary: '[MOCK] проверка без LLM',
    })),
  };
}
