import type { z } from 'zod';
import type { LlmConfig } from '@cms/core';
import type { AgentName } from './prompts.js';
import { CeoPlan, Review } from './schemas.js';

export type ModelRole = keyof LlmConfig['models'];

/**
 * Every agent is described exactly once here. The web panel, statistics and (stage 2.5
 * step 2) pause/model/prompt management are all built from this list: a new agent added
 * here shows up in the panel without touching the panel code.
 */
export interface AgentDefinition {
  id: AgentName;
  name: string;
  /** One line shown on the card. */
  role: string;
  description: string;
  /** Which LLM_MODEL_* role it uses. */
  modelRole: ModelRole;
  /** System prompt file in packages/agents/prompts (without .md). */
  prompt: AgentName;
  /** Output contract (documentation for the panel; validation lives in the agent). */
  output: z.ZodType | { describe: string };
}

export const AGENTS: readonly AgentDefinition[] = [
  {
    id: 'ceo',
    name: 'CEO',
    role: 'Разбирает бриф и составляет план работ',
    description:
      'Превращает бриф в список единиц контента для команды и отправляет план вам на утверждение.',
    modelRole: 'ceo',
    prompt: 'ceo',
    output: CeoPlan,
  },
  {
    id: 'copywriter',
    name: 'Копирайтер',
    role: 'Пишет тексты для Instagram и Telegram',
    description:
      'По 3 варианта на каждую единицу контента: хук, текст, CTA; для Reels — сценарий по секундам.',
    modelRole: 'worker',
    prompt: 'copywriter',
    // The real schema depends on the plan (deliverable ids): copywriterOutputSchema(deliverables).
    output: {
      describe:
        'items[]: по каждой единице контента 3 варианта (angle, hook, body, cta), slides, reelsScript',
    },
  },
  {
    id: 'critic',
    name: 'Critic',
    role: 'Проверяет тексты до того, как их увидите вы',
    description:
      'Чек-лист: бриф, голос бренда, штампы и канцелярит, фактура, длина и формат. До 2 доработок.',
    modelRole: 'critic',
    prompt: 'critic',
    output: Review,
  },
];

export function agentById(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id === id);
}
