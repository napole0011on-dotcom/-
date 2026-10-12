import { z } from 'zod';
import { EXTERNAL_DATA_RULES, wrapExternalData } from '@cms/engine';
import { renderBrandForPrompt } from '../brand.js';
import { genericReview } from '../constructor.js';
import type { NodeExecutor, NodeInput, NodeRender } from '../nodes.js';
import {
  formatMoney,
  loadCatalog,
  priceScope,
  type KpLine,
  type KpTotals,
} from '../tools/catalog.js';
import { json, type AgentContext, type AgentResult } from './context.js';

/** What the model returns: text and catalog ids. No prices, no sums. */
export const KpDraft = z
  .object({
    client: z.string().min(1),
    intro: z.string().min(10),
    scope: z
      .array(
        z.object({
          item_id: z.string().min(1),
          qty: z.number().positive(),
          comment: z.string(),
        }),
      )
      .min(1)
      .max(30),
    timeline: z.array(z.object({ stage: z.string().min(2), duration: z.string().min(1) })),
    assumptions: z.array(z.string()),
    terms: z.string(),
    next_step: z.string().min(3),
    cases_used: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .meta({ title: 'KpDraft' });
export type KpDraft = z.infer<typeof KpDraft>;

export interface KpOutput {
  draft: KpDraft;
  lines: KpLine[];
  totals: KpTotals;
  /** Model warnings + code warnings (unknown positions, price on request, example catalog). */
  warnings: string[];
  catalogHash: string;
  catalogExample: boolean;
  requisites: { company: string; details: string; contact: string } | null;
  cases: { id: string; title: string; text: string }[];
}

const CRITERIA = [
  'все позиции есть в справочнике (иначе — предупреждение для человека)',
  'итоговая сумма равна сумме по позициям (её посчитала программа, проверь, что текст ей не противоречит)',
  'нет обещаний сроков, гарантий и результатов вне брифа',
  'нет выдуманных кейсов: только из библиотеки',
  'данные клиента не перепутаны',
];

/** Agent «КП»: text by the model, prices and totals from the catalog by code. */
export function kpExecutor(d: { catalogFile: string; vatPercent: number }): NodeExecutor {
  return {
    async run(ctx: AgentContext, input: NodeInput): Promise<AgentResult<KpOutput>> {
      const prompt = ctx.prompts.kp;
      const catalog = loadCatalog(d.catalogFile);
      const parts = [
        `Бриф клиента:\n${wrapExternalData('brief', input.brief)}`,
        `Справочник услуг (выбирай только эти id; цены посчитает программа):\n${wrapExternalData(
          'catalog',
          json(catalog.items.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))),
        )}`,
        `Библиотека кейсов:\n${wrapExternalData('cases', json(catalog.cases))}`,
      ];
      for (const u of input.upstream)
        parts.push(
          `Результат шага «${u.name}»:\n${wrapExternalData(`step:${u.agent}`, json(u.items))}`,
        );
      if (input.previous != null)
        parts.push(
          `Прошлая версия КП:\n${wrapExternalData('previous', json((input.previous as KpOutput).draft))}`,
        );
      if (input.ownerComment)
        parts.push(`Комментарий владельца (главное, учти обязательно):\n${input.ownerComment}`);
      if (input.criticIssues.length)
        parts.push(`Замечания проверяющего (исправь):\n${json(input.criticIssues)}`);
      const r = await ctx.llm.callStructured({
        ctx: {
          brandId: ctx.brand.id,
          taskId: ctx.taskId,
          runId: ctx.runId,
          agent: 'kp',
          promptVersion: prompt.version,
        },
        model: ctx.models.worker,
        system: [
          { text: prompt.text, cache: true },
          { text: renderBrandForPrompt(ctx.brand), cache: true },
          { text: EXTERNAL_DATA_RULES },
        ],
        prompt: parts.join('\n\n'),
        schema: KpDraft,
        maxTokens: 6000,
        effort: 'medium',
        idempotencyKey: `${ctx.callKey}:kp:${input.step}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const priced = priceScope(catalog, r.output.scope, d.vatPercent);
      const knownCases = new Set(catalog.cases.map((c) => c.id));
      const badCases = r.output.cases_used.filter((c) => !knownCases.has(c));
      return {
        output: {
          draft: { ...r.output, cases_used: r.output.cases_used.filter((c) => knownCases.has(c)) },
          lines: priced.lines,
          totals: priced.totals,
          warnings: [
            ...r.output.warnings,
            ...priced.warnings,
            ...badCases.map((c) => `Кейса «${c}» нет в библиотеке — убран`),
          ],
          catalogHash: catalog.hash,
          catalogExample: catalog.example,
          requisites: catalog.requisites ?? null,
          cases: catalog.cases.filter((c) => r.output.cases_used.includes(c.id)),
        },
        promptVersion: prompt.version,
        model: r.servedModel,
        costUsd: r.costUsd,
      };
    },
    render(output: unknown): NodeRender {
      return renderKp(output as KpOutput);
    },
    review(ctx, input, output) {
      const o = output as KpOutput;
      return genericReview(
        ctx,
        input,
        { draft: o.draft, lines: o.lines, totals: o.totals, warnings: o.warnings },
        { id: 'kp', name: 'КП', role: 'коммерческое предложение', criteria: CRITERIA },
      );
    },
  };
}

export function renderKp(o: KpOutput): NodeRender {
  const c = o.totals.currency;
  const total = `${o.totals.hasOnRequest ? 'от ' : ''}${formatMoney(o.totals.totalMinor, c)}`;
  return {
    title: `КП для ${o.draft.client}: ${total}`,
    lines: [
      ...o.lines.map(
        (l) =>
          `${l.name} — ${l.qty} ${l.unit} × ${l.priceMinor === null ? 'по запросу' : formatMoney(l.priceMinor, c)} = ${l.totalMinor === null ? 'по запросу' : formatMoney(l.totalMinor, c)}${l.inCatalog ? '' : ' (нет в справочнике)'}`,
      ),
      `Итого: ${total}${o.totals.vatPercent ? `, в т. ч. НДС ${o.totals.vatPercent}% ${formatMoney(o.totals.vatMinor, c)}` : ', без НДС'}`,
      ...o.warnings.map((w) => `⚠ ${w}`),
    ],
  };
}
