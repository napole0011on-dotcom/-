import { renderBrandForPrompt } from '../brand.js';
import { loadPrompt } from '../prompts.js';
import { CeoPlan } from '../schemas.js';
import { json, type AgentContext, type AgentResult } from './context.js';

export interface CeoInput {
  brief: string;
  previousPlan?: CeoPlan;
  ownerComment?: string;
}

/** CEO (stage 2: simplified) — turns a brief into a list of deliverables for the copywriter. */
export async function runCeo(ctx: AgentContext, input: CeoInput): Promise<AgentResult<CeoPlan>> {
  const prompt = loadPrompt('ceo');
  const parts = [`Бриф владельца:\n${input.brief}`];
  if (input.previousPlan) parts.push(`Прошлый план:\n${json(input.previousPlan)}`);
  if (input.ownerComment)
    parts.push(`Комментарий владельца к прошлому плану (учти обязательно):\n${input.ownerComment}`);
  const r = await ctx.llm.callStructured({
    ctx: {
      brandId: ctx.brand.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agent: 'ceo',
      promptVersion: prompt.version,
    },
    model: ctx.models.ceo,
    system: [
      { text: prompt.text, cache: true },
      { text: renderBrandForPrompt(ctx.brand), cache: true },
    ],
    prompt: parts.join('\n\n'),
    schema: CeoPlan,
    maxTokens: 8000,
    effort: 'medium',
    idempotencyKey: `${ctx.callKey}:ceo`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return {
    output: r.output,
    promptVersion: prompt.version,
    model: r.servedModel,
    costUsd: r.costUsd,
  };
}
