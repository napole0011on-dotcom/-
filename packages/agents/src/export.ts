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
import type { NodeFile, NodeRender } from './nodes.js';

/** An approved result of another graph step (SEO, Image, KP, ...). */
export interface ExportNodeItem {
  artifactId: string;
  version: number;
  agent: string;
  agentName: string;
  promptVersion: string;
  model: string | null;
  render: NodeRender;
  output: unknown;
  /** Files of the step (images), copied to `<agent>/<name>` in the export folder. */
  files?: NodeFile[];
}

export interface ExportItem {
  artifactId: string;
  version: number;
  promptVersion: string;
  model: string | null;
  deliverable: Deliverable;
  item: CopyItem;
  critic: Verdict | null;
  criticRejected: boolean;
  /** Variant chosen at approval (1-3), null = all variants. */
  choice: number | null;
}

export function renderPackageMarkdown(
  title: string,
  brief: string,
  items: ExportItem[],
  spentUsd: number,
  nodes: ExportNodeItem[] = [],
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
    const v = e.critic;
    out.push(
      ...(v
        ? [
            `Проверка: ${v.passed ? 'одобрено' : e.criticRejected ? 'НЕ одобрено после 2 доработок' : 'есть замечания'} — ${v.summary}`,
            ...CHECK_NAMES.map(
              (c) =>
                `- ${CHECK_LABEL[c]}: ${v.checks[c].ok ? 'ок' : 'нет'}${v.checks[c].comment ? ` (${v.checks[c].comment})` : ''}`,
            ),
          ]
        : ['Проверка: без проверки (на доске нет проверяющего)']),
      '',
      `Версия ${e.version}, промпт ${e.promptVersion}, модель ${e.model ?? '—'}`,
      '',
    );
  }
  for (const n of nodes) {
    out.push(
      `## ${n.agentName}: ${n.render.title}`,
      '',
      ...n.render.lines.map((l) => `- ${l}`),
      ...(n.files?.length ? ['', ...n.files.map((f) => `- файл: ${n.agent}/${f.name}`)] : []),
      '',
      `Версия ${n.version}, промпт ${n.promptVersion}, модель ${n.model ?? '—'}`,
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
  nodes: ExportNodeItem[] = [],
  readFile?: (key: string) => Promise<Buffer>,
): Promise<{ dir: string; files: { name: string; content: Buffer }[] }> {
  const dir = path.join(exportDir, `${now.toISOString().slice(0, 10)}_${task.id.slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const files = [
    {
      name: 'package.md',
      content: Buffer.from(
        renderPackageMarkdown(task.title, task.brief, items, spentUsd, nodes),
        'utf8',
      ),
    },
    {
      name: 'package.json',
      content: Buffer.from(
        JSON.stringify({ task, spentUsd, exportedAt: now.toISOString(), items, nodes }, null, 2),
        'utf8',
      ),
    },
  ];
  for (const f of files) await writeFile(path.join(dir, f.name), f.content);
  if (readFile) {
    for (const n of nodes) {
      if (!n.files?.length) continue;
      const sub = path.join(dir, n.agent);
      await mkdir(sub, { recursive: true });
      // Names come from code (deliverable id + extension), never from the model's free text.
      for (const f of n.files)
        await writeFile(path.join(sub, path.basename(f.name)), await readFile(f.key));
    }
  }
  return { dir, files };
}
