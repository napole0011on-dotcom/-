import { errorToJson } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';
import type { AgentResult } from './agents/context.js';
import type { AgentDefinition } from './registry.js';

const { agentInvocations } = schema;

export interface InvocationTarget {
  brandId: string;
  taskId: string | null;
  runId: string | null;
  model: string;
  /** Active prompt version label at the start of the call. */
  promptVersion: string;
}

/**
 * Runs one agent call and records it (status, prompt version, model, cost, latency).
 * Every agent call in the workflow goes through here.
 */
export async function invokeAgent<T>(
  db: DbOrTx,
  def: AgentDefinition,
  target: InvocationTarget,
  fn: () => Promise<AgentResult<T>>,
): Promise<AgentResult<T>> {
  const started = Date.now();
  const [row] = await db
    .insert(agentInvocations)
    .values({
      brandId: target.brandId,
      agent: def.id,
      taskId: target.taskId,
      runId: target.runId,
      promptVersion: target.promptVersion,
      model: target.model,
    })
    .returning({ id: agentInvocations.id });
  try {
    const result = await fn();
    await db
      .update(agentInvocations)
      .set({
        status: 'succeeded',
        promptVersion: result.promptVersion,
        costUsd: result.costUsd.toFixed(8),
        latencyMs: Date.now() - started,
        finishedAt: sql`now()`,
      })
      .where(sql`${agentInvocations.id} = ${row!.id}`);
    return result;
  } catch (err) {
    await db
      .update(agentInvocations)
      .set({
        status: 'failed',
        error: errorToJson(err),
        latencyMs: Date.now() - started,
        finishedAt: sql`now()`,
      })
      .where(sql`${agentInvocations.id} = ${row!.id}`);
    throw err;
  }
}
