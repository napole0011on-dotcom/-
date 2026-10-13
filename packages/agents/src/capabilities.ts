import type { LlmConfig } from '@cms/core';
import { TOOL_CAPABILITIES } from './graph.js';
import { TOOLS, type ToolDefinition } from './tools/registry.js';

export type ModelRole = keyof LlmConfig['models'];

/**
 * Capabilities: behaviour implemented in code that an agent can be given («Инструмент» in the
 * block editor). They are not agents and are not on the board: an agent with the capability
 * is. No agent with a capability -> nobody can do it. Side effects keep their old guards
 * (permissions, mock by default, budget reserve -> finalize, a gate before irreversible ones).
 */
export interface Capability {
  id: string;
  name: string;
  description: string;
  /** llm: the agent's prompt and model are used, the output schema is fixed by code; tool: no LLM. */
  kind: 'llm' | 'tool';
  /** What the real (non-mock) mode needs from the owner; null: nothing. */
  realNeeds: string | null;
  /** Tool capabilities: permissions and .env parameters (read-only in the panel). */
  tool?: ToolDefinition;
}

const LLM_CAPABILITIES: Capability[] = [
  {
    id: 'copywriting',
    name: 'Тексты по плану',
    description:
      'По 3 варианта на каждую единицу контента из плана: хук, текст, CTA; для Reels — сценарий по секундам. Проверяющий проверяет по чек-листу.',
    kind: 'llm',
    realNeeds: null,
  },
  {
    id: 'image_generate',
    name: 'Картинки (Magnific)',
    description:
      'Задания для генератора по плану и текстам, генерация и хранение картинок. Сейчас — mock Magnific.',
    kind: 'llm',
    realNeeds: 'ключ Magnific и PROVIDERS_MODE=real (нужен ваш «ок»)',
  },
  {
    id: 'kp_draft',
    name: 'Коммерческое предложение',
    description:
      'Текст КП и состав работ из справочника. Цены, итог и НДС считает программа, а не модель.',
    kind: 'llm',
    realNeeds: null,
  },
];

const REAL_NEEDS: Record<string, string> = {
  stt_voice: 'облачный STT (STT_PROVIDER=cloud) — по желанию; whisper.cpp работает локально',
  video_transcribe: 'облачный STT (STT_PROVIDER=cloud) — по желанию; whisper.cpp работает локально',
  mailer_send: 'SMTP или UniOne (MAIL_PROVIDER=smtp) — нужен ваш «ок»',
};

export const CAPABILITIES: readonly Capability[] = [
  ...LLM_CAPABILITIES,
  ...TOOLS.map((t): Capability => ({
    id: t.id,
    name: t.name,
    description: t.description,
    kind: 'tool',
    realNeeds: REAL_NEEDS[t.id] ?? null,
    tool: t,
  })),
];

export const capabilityById = (id: string | null | undefined): Capability | undefined =>
  id ? CAPABILITIES.find((c) => c.id === id) : undefined;

/** A tool capability runs without an LLM: no prompt and no model are needed. */
export const isToolCapability = (id: string | null | undefined) =>
  !!id && (TOOL_CAPABILITIES as readonly string[]).includes(id);
