import type { CopyItem, Issue } from './schemas.js';
import { fullCaption } from './schemas.js';

/**
 * Deterministic checks that do not depend on the LLM: banned words from the brand
 * profile and the AI-cliché / bureaucratese list. A hit forces the Critic verdict to fail.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "уникальн*" -> matches "уникальный", "уникальная"...; whole words only (Unicode-aware). */
export function phraseRegex(phrase: string): RegExp {
  const trimmed = phrase.trim().toLowerCase().replace(/ё/g, 'е');
  const wildcard = trimmed.endsWith('*');
  const core = escapeRe(wildcard ? trimmed.slice(0, -1) : trimmed).replace(/\s+/g, '\\s+');
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${core}${wildcard ? '\\p{L}*' : ''}(?![\\p{L}\\p{N}])`,
    'iu',
  );
}

const normalise = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

export interface LintHit {
  variant: number | null;
  phrase: string;
  kind: 'banned' | 'cliche';
}

export function findPhrases(
  item: CopyItem,
  phrases: { phrase: string; kind: LintHit['kind'] }[],
): LintHit[] {
  const hits: LintHit[] = [];
  const texts: [number | null, string][] = item.variants.map((v, i) => [i + 1, fullCaption(v)]);
  if (item.slides) texts.push([null, item.slides.join('\n')]);
  if (item.reelsScript)
    texts.push([null, item.reelsScript.map((s) => `${s.voiceover}\n${s.onScreenText}`).join('\n')]);
  for (const { phrase, kind } of phrases) {
    const re = phraseRegex(phrase);
    for (const [variant, text] of texts) {
      if (re.test(normalise(text))) hits.push({ variant, phrase, kind });
    }
  }
  return hits;
}

export function hitsToIssues(hits: LintHit[]): Issue[] {
  return hits.map((h) => ({
    variant: h.variant,
    problem:
      h.kind === 'banned'
        ? `запрещённое слово бренда: «${h.phrase}»`
        : `штамп/канцелярит: «${h.phrase}»`,
    fix: 'переформулировать простыми словами без этого оборота',
  }));
}
