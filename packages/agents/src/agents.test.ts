import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '@cms/core';
import { loadBrandProfileFile } from './brand.js';
import { estimatePlan } from './estimate.js';
import { findPhrases, phraseRegex } from './lint.js';
import { loadClicheList, loadPrompt, parsePrompt } from './prompts.js';
import { CeoPlan, copywriterOutputSchema, formatProblems, type CopyItem } from './schemas.js';
import { loadPricing } from '@cms/core';

const variant = (
  hook = 'Хватит листать ленту',
  body = 'Три идеи для постов на неделю без воды и штампов.',
) => ({
  angle: 'польза',
  hook,
  body,
  cta: 'Сохрани',
});
const item = (over: Partial<CopyItem> = {}): CopyItem => ({
  deliverableId: 'post-1',
  variants: [variant(), variant(), variant()],
  slides: null,
  reelsScript: null,
  ...over,
});

describe('platform rules', () => {
  it('accepts a valid Instagram post', () => {
    expect(formatProblems(item(), 'instagram_post')).toEqual([]);
  });

  it('hook over 125 chars and caption over 2200 chars are rejected', () => {
    const long = item({
      variants: [variant('х'.repeat(126)), variant('ок хук', 'т'.repeat(2200)), variant()],
    });
    const p = formatProblems(long, 'instagram_post');
    expect(p.join('\n')).toMatch(/variant 1: hook is 126 chars/);
    expect(p.join('\n')).toMatch(/variant 2: text is \d+ chars, max 2200/);
  });

  it('Telegram allows up to 4096 chars', () => {
    const t = item({ variants: [variant('ок хук', 'т'.repeat(3000)), variant(), variant()] });
    expect(formatProblems(t, 'telegram_post')).toEqual([]);
    expect(formatProblems(t, 'instagram_post').length).toBe(1);
  });

  it('Reels need a contiguous script starting at 0; carousels need 2-10 slides', () => {
    expect(formatProblems(item(), 'instagram_reels')).toContain('reelsScript: required for Reels');
    const gap = item({
      reelsScript: [
        { fromSec: 0, toSec: 3, visual: 'кадр', voiceover: '', onScreenText: '' },
        { fromSec: 5, toSec: 9, visual: 'кадр', voiceover: '', onScreenText: '' },
      ],
    });
    expect(formatProblems(gap, 'instagram_reels').join()).toMatch(/starts at 5s, expected 3s/);
    expect(formatProblems(item({ slides: ['один'] }), 'instagram_carousel').join()).toMatch(
      /2-10 slides/,
    );
    expect(formatProblems(item({ slides: ['a', 'b'] }), 'instagram_post')).toContain(
      'slides: must be null for this platform',
    );
  });

  it('copywriter schema requires every deliverable exactly once', () => {
    const s = copywriterOutputSchema([
      { id: 'post-1', platform: 'instagram_post' },
      { id: 'tg-1', platform: 'telegram_post' },
    ]);
    const r = s.safeParse({ items: [item()] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/tg-1 must appear exactly once/);
    expect(s.safeParse({ items: [item(), item({ deliverableId: 'tg-1' })] }).success).toBe(true);
  });

  it('plan ids must be unique', () => {
    const d = { id: 'post-1', platform: 'instagram_post', topic: 'тема', goal: 'цель', notes: '' };
    expect(
      CeoPlan.safeParse({
        summary: 'Сделаем два поста',
        assumptions: [],
        questions: [],
        deliverables: [d, d],
      }).success,
    ).toBe(false);
  });
});

describe('cliché and banned-word detection', () => {
  it('matches whole words, any case, ё/е, with * endings', () => {
    expect(phraseRegex('уникальн*').test('наш уникальный кофе')).toBe(true);
    expect(phraseRegex('данный').test('данные показывают')).toBe(false);
    expect(phraseRegex('в современном мире').test('в  современном  мире всё быстро')).toBe(true);
    expect(
      findPhrases(
        item({ variants: [variant('Мы рады представить новинку'), variant(), variant()] }),
        [{ phrase: 'мы рады представить', kind: 'cliche' }],
      ),
    ).toEqual([{ variant: 1, phrase: 'мы рады представить', kind: 'cliche' }]);
  });

  it('ships a non-empty cliché list', () => {
    expect(loadClicheList().length).toBeGreaterThan(20);
  });
});

describe('prompts and brand profile', () => {
  it('prompt version = declared version + content hash', () => {
    const a = parsePrompt('ceo', '---\nversion: 3\n---\nHello');
    const b = parsePrompt('ceo', '---\r\nversion: 3\r\n---\r\nHello!');
    expect(a.version).toMatch(/^ceo@3#[0-9a-f]{8}$/);
    expect(b.version).not.toBe(a.version);
    expect(() => parsePrompt('ceo', 'no front matter')).toThrow(/version/);
    for (const agent of ['ceo', 'copywriter', 'critic'] as const)
      expect(loadPrompt(agent).version).toMatch(new RegExp(`^${agent}@\\d+#`));
  });

  it('default brand profile loads and validates', () => {
    const p = loadBrandProfileFile(path.join(findRepoRoot(), 'config', 'brands', 'default.yaml'));
    expect(p.slug).toBe('default');
    expect(p.language).toBe('ru');
  });

  it('plan estimate: expected <= max, both well under the $2 task limit for 2 items', () => {
    const pricing = loadPricing(path.join(findRepoRoot(), 'config', 'model-pricing.json'));
    const d = {
      id: 'p',
      platform: 'instagram_post' as const,
      topic: 'тема',
      goal: 'цель',
      notes: '',
    };
    const e = estimatePlan(
      { summary: 's', assumptions: [], questions: [], deliverables: [d, { ...d, id: 'q' }] },
      pricing,
      {
        ceo: 'claude-opus-5-5',
        critic: 'claude-opus-5-5',
        worker: 'claude-sonnet-5-5',
        classifier: 'claude-haiku-5-5',
      },
    );
    expect(e.expectedUsd).toBeLessThanOrEqual(e.maxUsd);
    expect(e.maxUsd).toBeLessThan(2);
  });
});
