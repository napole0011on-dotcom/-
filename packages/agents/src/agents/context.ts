import type { LlmConfig } from '@cms/core';
import type { LlmClient } from '@cms/engine';
import type { BrandRecord } from '../brand.js';

/** Everything an agent may use. Agents have no tools with side effects: they only return data. */
export interface AgentContext {
  llm: LlmClient;
  models: LlmConfig['models'];
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
