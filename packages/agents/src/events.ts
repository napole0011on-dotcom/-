import { errorToJson, type Logger } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';

const { agentEvents } = schema;

export type EventKind =
  | 'started'
  | 'finished'
  | 'failed'
  | 'plan_ready'
  | 'verdict'
  | 'waiting_owner'
  | 'decision'
  | 'exported'
  | 'retry'
  | 'wait'
  | 'info';

export interface AgentEvent {
  brandId: string;
  agent: string;
  taskId?: string | null;
  runId?: string | null;
  kind: EventKind;
  text: string;
  costUsd?: number | null;
}

/**
 * Live feed for the board ("Что происходит сейчас"). Best effort: a failure to log an
 * event never breaks the agent run. A trigger NOTIFYs the panel API (SSE).
 */
export async function emitEvent(db: DbOrTx, e: AgentEvent, logger?: Logger): Promise<void> {
  try {
    await db.insert(agentEvents).values({
      brandId: e.brandId,
      agent: e.agent,
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      kind: e.kind,
      text: e.text.slice(0, 300),
      costUsd: e.costUsd == null ? null : e.costUsd.toFixed(8),
    });
  } catch (err) {
    logger?.warn({ err: errorToJson(err) }, 'agent event not recorded');
  }
}

export async function recentEvents(db: DbOrTx, brandId: string, limit = 50, afterId = 0) {
  const rows = await db
    .select()
    .from(agentEvents)
    .where(sql`${agentEvents.brandId} = ${brandId} and ${agentEvents.id} > ${afterId}`)
    .orderBy(sql`${agentEvents.id} desc`)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    agent: r.agent,
    taskId: r.taskId,
    runId: r.runId,
    kind: r.kind as EventKind,
    text: r.text,
    costUsd: r.costUsd == null ? null : Number(r.costUsd),
  }));
}
