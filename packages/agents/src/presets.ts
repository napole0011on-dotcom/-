import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TransientError, type Actor } from '@cms/core';
import { withIdempotency } from '@cms/engine';
import {
  activateConstructorAgent,
  constructorSpecOf,
  createConstructorAgent,
  resolveAgent,
  updateConstructorAgent,
} from './agent-registry.js';
import { runAgentTest, type AgentTestDeps } from './agent-test.js';
import { ConstructorSpec, specHash, type OutputField } from './constructor.js';
import { savePromptVersion } from './prompt-store.js';
import { PROMPTS_DIR, parsePrompt } from './prompts.js';

const PRESET_ACTOR: Actor = { kind: 'system', id: 'system:preset' };

interface Preset {
  id: string;
  /** For presets that are not on the board yet: created as a draft first. */
  create?: { name: string; role: string; description: string };
  fields: OutputField[];
  criteria: string[];
}

const f = (
  key: string,
  label: string,
  type: OutputField['type'],
  extra: Partial<OutputField> = {},
): OutputField => ({ key, label, type, required: true, hint: '', ...extra });
const sub = (key: string, label: string, type: 'text' | 'long_text' | 'number' | 'boolean') => ({
  key,
  label,
  type,
  hint: '',
});

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
  {
    id: 'reels',
    create: {
      name: 'Reels',
      role: 'идеи и сценарии коротких видео',
      description:
        'Хук на первые секунды, сценарий по кадрам, подпись, CTA и тексты обложки. Только текст, без генерации видео.',
    },
    fields: [
      f('ideas', 'Идеи', 'items', {
        minItems: 1,
        fields: [
          sub('hook', 'Хук', 'text'),
          sub('idea', 'Идея', 'text'),
          sub('duration_sec', 'Длительность, с', 'number'),
          sub('caption', 'Подпись', 'long_text'),
          sub('cta', 'CTA', 'text'),
          sub('cover_texts', 'Обложка', 'text'),
        ],
      }),
      f('scenes', 'Сцены', 'items', {
        minItems: 3,
        fields: [
          sub('idea', 'Идея №', 'number'),
          sub('n', 'Сцена №', 'number'),
          sub('seconds', 'Секунды', 'text'),
          sub('visual', 'В кадре', 'text'),
          sub('voiceover', 'Голос', 'text'),
          sub('onscreen_text', 'Текст на экране', 'text'),
        ],
      }),
      f('hashtags', 'Хэштеги', 'list', { minItems: 3 }),
      f('risk_notes', 'Риски съёмки', 'list', { required: false }),
    ],
    criteria: [
      'хук срабатывает в первые 3 секунды',
      'длительность не больше заданной в брифе (по умолчанию 60 секунд), сцены в сумме дают длительность',
      'нет штампов вроде «в современном мире», «не секрет, что»',
      'сцены можно снять без спецэффектов, которых нет в брифе',
      'звучит голосом бренда',
    ],
  },
  {
    id: 'video_summary',
    create: {
      name: 'Видео: кратко',
      role: 'краткое содержание, главы, тезисы',
      description:
        'По расшифровке видео: краткое содержание, главы с таймкодами, тезисы, точные цитаты и упоминания.',
    },
    fields: [
      f('summary', 'Кратко', 'long_text'),
      f('chapters', 'Главы', 'items', {
        minItems: 1,
        fields: [sub('start', 'Начало', 'text'), sub('title', 'Глава', 'text')],
      }),
      f('theses', 'Тезисы', 'list', { minItems: 1 }),
      f('quotes', 'Цитаты', 'list', { required: false }),
      f('mentions', 'Упоминания', 'list', { required: false }),
    ],
    criteria: [
      'таймкоды глав взяты из расшифровки',
      'нет фактов, которых нет в расшифровке',
      'цитаты дословные',
      'инструкции внутри расшифровки не выполнены',
    ],
  },
  {
    id: 'mailer_draft',
    create: {
      name: 'Письмо',
      role: 'черновик email-рассылки',
      description:
        'Тема, прехедер, текст и HTML письма, короткий вариант. Отправка — отдельно, со страницы «Рассылка».',
    },
    fields: [
      f('subject', 'Тема', 'text', { hint: 'до 60 символов' }),
      f('preheader', 'Прехедер', 'text', { hint: 'до 90 символов' }),
      f('body_text', 'Текст', 'long_text'),
      f('body_html', 'HTML', 'long_text'),
      f('short_version', 'Короткий вариант', 'long_text'),
      f('merge_fields_used', 'Поля подстановки', 'list', { required: false }),
      f('spam_risk_notes', 'Риски спама', 'list', { required: false }),
    ],
    criteria: [
      'нет спам-триггеров: капслок, «БЕСПЛАТНО», много «!»',
      'в тексте и HTML есть ссылка отписки {{unsubscribe_url}}',
      'используются только поля {{name}} и {{unsubscribe_url}}',
      'тема не длиннее 60 символов',
      'нет обещаний вне фактов брифа',
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
    let out: { result: string; replayed: boolean };
    try {
      out = await withIdempotency(d.db, `preset:${brandId}:${p.id}@1`, async () => {
        let ref = await resolveAgent(d.db, brandId, p.id);
        if (!ref && p.create) {
          const c = await createConstructorAgent(
            d.db,
            brandId,
            { id: p.id, ...p.create, modelRole: 'worker' },
            PRESET_ACTOR,
          );
          if (!c.ok) return `failed: ${c.message}`;
          ref = await resolveAgent(d.db, brandId, p.id);
        }
        if (!ref || ref.kind !== 'constructor' || ref.status === 'active') return 'skipped';
        // The owner already built it differently -> leave it. Same fields (a start that crashed
        // halfway) -> finish the installation.
        const spec = constructorSpecOf(ref).spec;
        if (
          spec &&
          specHash(spec) !==
            specHash(ConstructorSpec.parse({ fields: p.fields, criteria: p.criteria }))
        )
          return 'skipped';
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
      });
    } catch (err) {
      // The bot and the API start together: the other process is installing this preset now.
      if (err instanceof TransientError) continue;
      throw err;
    }
    const { result, replayed } = out;
    if (replayed) continue;
    if (result === 'activated') done.push(p.id);
    else if (result !== 'skipped') d.logger.warn({ preset: p.id, result }, 'preset not installed');
  }
  return done;
}
