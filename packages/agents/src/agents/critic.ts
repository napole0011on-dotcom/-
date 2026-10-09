import { renderBrandForPrompt } from '../brand.js';
import { EXTERNAL_DATA_RULES, wrapExternalData } from '@cms/engine';
import { findPhrases, hitsToIssues } from '../lint.js';
import { loadClicheList } from '../prompts.js';
import {
  CHECK_NAMES,
  criticOutputSchema,
  type CopyItem,
  type Deliverable,
  type Review,
} from '../schemas.js';
import type { AgentContext, AgentResult } from './context.js';

export interface CriticInput {
  brief: string;
  deliverables: Deliverable[];
  items: CopyItem[];
  step: string;
}

/** Final verdict after combining the LLM review with deterministic checks. */
export interface Verdict extends Review {
  /** True only if the LLM said pass, every check is ok and no banned word/cliché was found. */
  passed: boolean;
}

export function combineVerdict(
  review: Review,
  item: CopyItem,
  phrases: { phrase: string; kind: 'banned' | 'cliche' }[],
): Verdict {
  const hits = findPhrases(item, phrases);
  const allOk = CHECK_NAMES.every((c) => review.checks[c].ok);
  const passed = review.verdict === 'pass' && allOk && hits.length === 0;
  const checks = { ...review.checks };
  if (hits.length > 0) {
    checks.clichesAndBureaucratese = {
      ok: false,
      comment: [
        checks.clichesAndBureaucratese.comment,
        `найдено автоматически: ${hits.map((h) => h.phrase).join(', ')}`,
      ]
        .filter(Boolean)
        .join('; '),
    };
  }
  return {
    ...review,
    checks,
    verdict: passed ? 'pass' : 'fail',
    issues: [...hitsToIssues(hits), ...review.issues].slice(0, 10),
    passed,
  };
}

export async function runCritic(
  ctx: AgentContext,
  input: CriticInput,
): Promise<AgentResult<Verdict[]>> {
  const prompt = ctx.prompts.critic;
  const cliches = loadClicheList();
  const banned = ctx.brand.profile.bannedWords;
  const ids = input.items.map((i) => i.deliverableId);
  const r = await ctx.llm.callStructured({
    ctx: {
      brandId: ctx.brand.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agent: 'critic',
      promptVersion: prompt.version,
    },
    model: ctx.models.critic,
    system: [
      {
        text: `${prompt.text}\n\nЗапрещённые обороты:\n${[...cliches, ...banned].join('\n')}\n\n${EXTERNAL_DATA_RULES}`,
        cache: true,
      },
      { text: renderBrandForPrompt(ctx.brand), cache: true },
    ],
    prompt: [
      `Бриф владельца:\n${input.brief}`,
      `План (единицы контента):\n${JSON.stringify(input.deliverables.filter((d) => ids.includes(d.id)))}`,
      `Тексты копирайтера на проверку:\n${wrapExternalData('copywriter-output', JSON.stringify(input.items, null, 2))}`,
    ].join('\n\n'),
    schema: criticOutputSchema(ids),
    maxTokens: 8000,
    effort: 'medium',
    idempotencyKey: `${ctx.callKey}:critic:${input.step}`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const phrases = [
    ...cliches.map((phrase) => ({ phrase, kind: 'cliche' as const })),
    ...banned.map((phrase) => ({ phrase, kind: 'banned' as const })),
  ];
  const verdicts = input.items.map((item) =>
    combineVerdict(
      r.output.reviews.find((rv) => rv.deliverableId === item.deliverableId)!,
      item,
      phrases,
    ),
  );
  return {
    output: verdicts,
    promptVersion: prompt.version,
    model: r.servedModel,
    costUsd: r.costUsd,
  };
}
