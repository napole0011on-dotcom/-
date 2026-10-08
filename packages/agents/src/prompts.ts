import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type AgentName = 'ceo' | 'copywriter' | 'critic';

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
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return { agent, text: body, version: `${agent}@${m[1]}#${hash}` };
}

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
