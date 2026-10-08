import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CHECK_LABEL,
  CHECK_NAMES,
  PLATFORM_LABEL,
  fullCaption,
  type CopyItem,
  type Deliverable,
} from './schemas.js';
import type { Verdict } from './agents/critic.js';

export interface ExportItem {
  artifactId: string;
  version: number;
  promptVersion: string;
  model: string | null;
  deliverable: Deliverable;
  item: CopyItem;
  critic: Verdict;
  criticRejected: boolean;
  /** Variant chosen at approval (1-3), null = all variants. */
  choice: number | null;
}

export function renderPackageMarkdown(
  title: string,
  brief: string,
  items: ExportItem[],
  spentUsd: number,
): string {
  const out: string[] = [
    `# ${title}`,
    '',
    `Бриф: ${brief}`,
    '',
    `Стоимость генерации: $${spentUsd.toFixed(4)}`,
    '',
  ];
  for (const e of items) {
    out.push(
      `## ${e.deliverable.id} — ${PLATFORM_LABEL[e.deliverable.platform]}`,
      '',
      `Тема: ${e.deliverable.topic}`,
      '',
    );
    const variants = e.choice
      ? [[e.choice, e.item.variants[e.choice - 1]!] as const]
      : e.item.variants.map((v, i) => [i + 1, v] as const);
    for (const [n, v] of variants) {
      out.push(
        `### Вариант ${n}${e.choice ? ' (выбран)' : ''} — ${v.angle}`,
        '',
        fullCaption(v),
        '',
      );
    }
    if (e.item.slides) {
      out.push('### Слайды', '', ...e.item.slides.map((s, i) => `${i + 1}. ${s}`), '');
    }
    if (e.item.reelsScript) {
      out.push(
        '### Сценарий Reels',
        '',
        '| Секунды | В кадре | Голос | Текст на экране |',
        '|---|---|---|---|',
      );
      for (const s of e.item.reelsScript) {
        out.push(
          `| ${s.fromSec}–${s.toSec} | ${s.visual} | ${s.voiceover} | ${s.onScreenText} |`.replace(
            /\n/g,
            ' ',
          ),
        );
      }
      out.push('');
    }
    out.push(
      `Critic: ${e.critic.passed ? 'одобрено' : e.criticRejected ? 'НЕ одобрено после 2 доработок' : 'есть замечания'} — ${e.critic.summary}`,
      ...CHECK_NAMES.map(
        (c) =>
          `- ${CHECK_LABEL[c]}: ${e.critic.checks[c].ok ? 'ок' : 'нет'}${e.critic.checks[c].comment ? ` (${e.critic.checks[c].comment})` : ''}`,
      ),
      '',
      `Версия ${e.version}, промпт ${e.promptVersion}, модель ${e.model ?? '—'}`,
      '',
    );
  }
  return out.join('\n');
}

/** Writes package.md + package.json into `<exportDir>/<date>_<task8>/`. Returns the folder and files. */
export async function writePackage(
  exportDir: string,
  task: { id: string; title: string; brief: string },
  items: ExportItem[],
  spentUsd: number,
  now = new Date(),
): Promise<{ dir: string; files: { name: string; content: Buffer }[] }> {
  const dir = path.join(exportDir, `${now.toISOString().slice(0, 10)}_${task.id.slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const files = [
    {
      name: 'package.md',
      content: Buffer.from(renderPackageMarkdown(task.title, task.brief, items, spentUsd), 'utf8'),
    },
    {
      name: 'package.json',
      content: Buffer.from(
        JSON.stringify({ task, spentUsd, exportedAt: now.toISOString(), items }, null, 2),
        'utf8',
      ),
    },
  ];
  for (const f of files) await writeFile(path.join(dir, f.name), f.content);
  return { dir, files };
}
