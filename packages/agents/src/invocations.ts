import { errorToJson } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';
import type { AgentResult } from './agents/context.js';
import { emitEvent } from './events.js';

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
  def: { id: string; name: string },
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
  const ev = { brandId: target.brandId, agent: def.id, taskId: target.taskId, runId: target.runId };
  await emitEvent(db, { ...ev, kind: 'started', text: `${def.name} · начал работу` });
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
    await emitEvent(db, {
      ...ev,
      kind: 'finished',
      text: `${def.name} · готово`,
      costUsd: result.costUsd,
    });
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
    await emitEvent(db, {
      ...ev,
      kind: 'failed',
      text: `${def.name} · ошибка: ${(err instanceof Error ? err.message : 'неизвестная ошибка').slice(0, 120)}`,
    });
    throw err;
  }
}
