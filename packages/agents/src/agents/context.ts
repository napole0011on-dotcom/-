import { PermanentError } from '@cms/core';
import type { LlmConfig } from '@cms/core';
import type { LlmClient } from '@cms/engine';
import type { BrandRecord } from '../brand.js';
import type { PromptMap } from '../prompts.js';

/** Everything an agent may use. Agents have no tools with side effects: they only return data. */
export interface AgentContext {
  llm: LlmClient;
  /** Effective models (LLM_MODEL_* in .env, or the panel override per agent). */
  models: LlmConfig['models'];
  /** Active prompt version per agent, resolved once per run (DB is the source of truth). */
  prompts: PromptMap;
  /** Model per registry agent (constructor agents may have their own override in the panel). */
  agentModels: Record<string, string>;
  brand: BrandRecord;
  taskId: string;
  runId: string | null;
  /** Prefix for idempotency keys of LLM calls inside this run. */
  callKey: string;
  signal?: AbortSignal;
}

export interface AgentResult<T> {
  output: T;
  promptVersion: string;
  model: string;
  costUsd: number;
}

/** Owner text is trusted (it is the instruction). Agent outputs passed onward are wrapped as data. */
export const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Which agent record a call runs as: its id selects the prompt, the model and the cost line. */
export interface AgentSelf {
  id: string;
  name: string;
}

/** The agent's active prompt (every agent is the owner's record with its own prompt). */
export function selfPrompt(ctx: AgentContext, self: AgentSelf) {
  const p = ctx.prompts[self.id];
  if (!p)
    throw new PermanentError(
      'prompt_missing',
      `У агента «${self.name}» нет активного промпта: сохраните его в «Настроить» → «Промпт»`,
    );
  return p;
}

/** The agent's model: its panel override, else LLM_MODEL_<role> of its model role. */
export function selfModel(
  ctx: AgentContext,
  self: AgentSelf,
  fallback: keyof AgentContext['models'],
): string {
  return ctx.agentModels[self.id] ?? ctx.models[fallback];
}
