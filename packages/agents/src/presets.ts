import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Actor } from '@cms/core';
import { withIdempotency } from '@cms/engine';
import {
  activateConstructorAgent,
  constructorSpecOf,
  resolveAgent,
  updateConstructorAgent,
} from './agent-registry.js';
import { runAgentTest, type AgentTestDeps } from './agent-test.js';
import type { OutputField } from './constructor.js';
import { savePromptVersion } from './prompt-store.js';
import { PROMPTS_DIR, parsePrompt } from './prompts.js';

const PRESET_ACTOR: Actor = { kind: 'system', id: 'system:preset' };

interface Preset {
  id: string;
  fields: OutputField[];
  criteria: string[];
}

/**
 * Ready-made constructor agents. They go through the same path as an agent the owner builds:
 * fields + prompt are saved, a mock test runs ($0), and only a passed test activates the agent.
 */
export const PRESETS: Preset[] = [
  {
    id: 'seo',
    fields: [
      {
        key: 'keywords',
        label: 'Ключевые слова',
        type: 'list',
        required: true,
        hint: 'как ищут тему в поиске Instagram и Telegram, по-русски',
        minItems: 3,
      },
      {
        key: 'hashtags',
        label: 'Хэштеги',
        type: 'list',
        required: true,
        hint: 'тематические и нишевые, каждый с #, без общих вроде #love',
        minItems: 5,
      },
      {
        key: 'search_title',
        label: 'Первая строка с ключом',
        type: 'text',
        required: true,
        hint: 'до 100 символов',
      },
      {
        key: 'notes',
        label: 'Рекомендации',
        type: 'list',
        required: false,
        hint: 'что поправить в текстах для поиска',
      },
    ],
    criteria: [
      'хэштеги и ключи относятся к теме поста и бренду, нет общих хэштегов',
      'только Instagram и Telegram: нет советов про сайты и поисковики',
      'нет выдуманных фактов, цен и акций',
    ],
  },
];

const presetPrompt = (id: string) =>
  parsePrompt(`presets/${id}`, readFileSync(path.join(PROMPTS_DIR, 'presets', `${id}.md`), 'utf8'))
    .text;

/**
 * Installs presets once per brand (idempotency key): a planned board agent with an empty spec
 * gets its fields, criteria and prompt, is tested on the mock and switched on if the test passed.
 * An agent the owner already edited or deleted is left alone.
 */
export async function installPresets(d: AgentTestDeps, brandId: string): Promise<string[]> {
  const done: string[] = [];
  for (const p of PRESETS) {
    const { result, replayed } = await withIdempotency(
      d.db,
      `preset:${brandId}:${p.id}@1`,
      async () => {
        const ref = await resolveAgent(d.db, brandId, p.id);
        if (!ref || ref.kind !== 'constructor' || ref.status === 'active') return 'skipped';
        if (constructorSpecOf(ref).spec) return 'skipped'; // the owner already built it
        const upd = await updateConstructorAgent(
          d.db,
          brandId,
          p.id,
          { fields: p.fields, criteria: p.criteria },
          PRESET_ACTOR,
        );
        if (!upd.ok) return `failed: ${upd.message}`;
        await savePromptVersion(d.db, brandId, p.id, presetPrompt(p.id), PRESET_ACTOR);
        const test = await runAgentTest(d, brandId, p.id, {}, PRESET_ACTOR);
        if (!test.ok) return `test failed: ${test.message}`;
        const act = await activateConstructorAgent(d.db, brandId, p.id, PRESET_ACTOR, () =>
          d.controls.release(),
        );
        return act.ok ? 'activated' : `failed: ${act.message}`;
      },
    );
    if (replayed) continue;
    if (result === 'activated') done.push(p.id);
    else if (result !== 'skipped') d.logger.warn({ preset: p.id, result }, 'preset not installed');
  }
  return done;
}
