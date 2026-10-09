import type { LlmConfig } from '@cms/core';
import type { LlmClient } from '@cms/engine';
import type { BrandRecord } from '../brand.js';
import type { AgentName, LoadedPrompt } from '../prompts.js';

/** Everything an agent may use. Agents have no tools with side effects: they only return data. */
export interface AgentContext {
  llm: LlmClient;
  /** Effective models (LLM_MODEL_* in .env, or the panel override per agent). */
  models: LlmConfig['models'];
  /** Active prompt version per agent, resolved once per run (DB is the source of truth). */
  prompts: Record<AgentName, LoadedPrompt>;
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
