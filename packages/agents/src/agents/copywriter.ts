import { renderBrandForPrompt } from '../brand.js';
import { loadClicheList, loadPrompt } from '../prompts.js';
import {
  copywriterOutputSchema,
  type CopyItem,
  type CopywriterOutput,
  type Deliverable,
  type Issue,
} from '../schemas.js';
import { json, type AgentContext, type AgentResult } from './context.js';

export interface RewriteRequest {
  previous: CopyItem;
  criticIssues?: Issue[];
  ownerComment?: string | null;
  /** regenerate = write new variants from scratch, ignoring the previous ones. */
  mode: 'revise' | 'regenerate';
}

export interface CopywriterInput {
  brief: string;
  planSummary: string;
  deliverables: Deliverable[];
  /** Per deliverable id: what to fix. Absent = first draft. */
  rewrites?: Record<string, RewriteRequest>;
  /** Distinguishes calls inside one run (round number etc.). */
  step: string;
}

export function copywriterSystem(ctx: AgentContext) {
  const prompt = loadPrompt('copywriter');
  const cliches = loadClicheList();
  return {
    prompt,
    system: [
      {
        text: `${prompt.text}\n\nЗапрещённые AI-штампы и канцелярит:\n${cliches.join('\n')}`,
        cache: true,
      },
      { text: renderBrandForPrompt(ctx.brand), cache: true },
    ],
  };
}

export async function runCopywriter(
  ctx: AgentContext,
  input: CopywriterInput,
): Promise<AgentResult<CopywriterOutput>> {
  const { prompt, system } = copywriterSystem(ctx);
  const parts = [
    `Бриф владельца:\n${input.brief}`,
    `Задача от CEO: ${input.planSummary}`,
    `Единицы контента:\n<deliverables_json>${JSON.stringify(input.deliverables)}</deliverables_json>`,
  ];
  for (const [id, rw] of Object.entries(input.rewrites ?? {})) {
    const lines = [
      `Переделка ${id} (${rw.mode === 'regenerate' ? 'написать заново, новые заходы' : 'исправить по замечаниям'}):`,
    ];
    if (rw.mode === 'revise') lines.push(`Прошлая версия:\n${json(rw.previous)}`);
    if (rw.ownerComment) lines.push(`Комментарий владельца (главное):\n${rw.ownerComment}`);
    if (rw.criticIssues?.length) lines.push(`Замечания критика:\n${json(rw.criticIssues)}`);
    parts.push(lines.join('\n'));
  }
  const r = await ctx.llm.callStructured({
    ctx: {
      brandId: ctx.brand.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agent: 'copywriter',
      promptVersion: prompt.version,
    },
    model: ctx.models.worker,
    system,
    prompt: parts.join('\n\n'),
    schema: copywriterOutputSchema(input.deliverables),
    maxTokens: 12_000,
    effort: 'medium',
    idempotencyKey: `${ctx.callKey}:copywriter:${input.step}`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return {
    output: r.output,
    promptVersion: prompt.version,
    model: r.servedModel,
    costUsd: r.costUsd,
  };
}
