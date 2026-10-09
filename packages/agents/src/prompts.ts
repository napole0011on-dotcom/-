import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const AGENT_NAMES = ['ceo', 'copywriter', 'critic'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Prompt size limit for versions saved from the panel. */
export const MAX_PROMPT_BYTES = 32 * 1024;

export const promptHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 8);

export const promptLabel = (agent: string, version: number | string, hash: string) =>
  `${agent}@${version}#${hash}`;

/** Normalises a prompt typed in the panel (line endings, outer whitespace). */
export const normalizePromptText = (text: string) => text.replace(/\r\n/g, '\n').trim();

/** Checks a prompt before it is saved as a version; returns a message for the owner or null. */
export function validatePromptText(raw: string): string | null {
  const text = normalizePromptText(raw);
  if (!text) return 'Промпт пустой';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PROMPT_BYTES)
    return `Промпт длиннее 32 КБ (сейчас ${(bytes / 1024).toFixed(1)} КБ)`;
  if (/^---\s*\n/.test(text))
    return 'Уберите блок «---» в начале (front matter): версия назначается автоматически';
  return null;
}

export interface LoadedPrompt {
  agent: AgentName;
  text: string;
  /** "copywriter@1#a1b2c3d4": declared version + content hash, stored with every LLM call and artifact. */
  version: string;
}

export const PROMPTS_DIR = path.resolve(import.meta.dirname, '..', 'prompts');

/** Parses `---\nversion: N\n---` front matter. Editing a prompt without bumping the version still changes the hash. */
export function parsePrompt(agent: AgentName, raw: string): LoadedPrompt {
  const text = raw.replace(/\r\n/g, '\n');
  const m = /^---\nversion:\s*(\d+)\s*\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`Prompt ${agent}.md must start with "---\\nversion: N\\n---"`);
  const body = m[2]!.trim();
  return { agent, text: body, version: promptLabel(agent, m[1]!, promptHash(body)) };
}

/** Reads the prompt FILE. At runtime agents use the active DB version (prompt-store.ts). */
export function loadPrompt(agent: AgentName, dir: string = PROMPTS_DIR): LoadedPrompt {
  return parsePrompt(agent, readFileSync(path.join(dir, `${agent}.md`), 'utf8'));
}

/** Phrases from ai-cliches.ru.txt ("*" = any ending). */
export function loadClicheList(dir: string = PROMPTS_DIR): string[] {
  return readFileSync(path.join(dir, 'ai-cliches.ru.txt'), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
