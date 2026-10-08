import { eq, sql, schema, type DbOrTx } from '@cms/db';
import {
  InvalidTransitionError,
  PermanentError,
  checkTransition,
  type Actor,
  type TaskStatus,
} from '@cms/core';

const { tasks, auditLog } = schema;

export interface TransitionInput {
  taskId: string;
  to: TaskStatus;
  actor: Actor;
  reason?: string;
  details?: Record<string, unknown>;
  /** If set, the transition only happens when the task is currently in this status. */
  expectedFrom?: TaskStatus;
}

export interface TransitionResult {
  changed: boolean;
  from: TaskStatus;
  to: TaskStatus;
  version: number;
}

/**
 * The only way to change tasks.status (a DB trigger rejects any other UPDATE).
 * Locks the row, validates against the transition table, writes the audit log entry
 * in the same transaction. Repeating a transition that already happened is a no-op,
 * so duplicate queue deliveries / double clicks are harmless.
 */
export async function transitionTask(
  db: DbOrTx,
  input: TransitionInput,
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        id: tasks.id,
        brandId: tasks.brandId,
        status: tasks.status,
        version: tasks.version,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update');
    if (!task) throw new PermanentError('task_not_found', `Task ${input.taskId} not found`);

    if (task.status === input.to) {
      return { changed: false, from: task.status, to: input.to, version: task.version };
    }
    if (input.expectedFrom && task.status !== input.expectedFrom) {
      throw new InvalidTransitionError(
        task.status,
        input.to,
        `expected current status ${input.expectedFrom}, found ${task.status}`,
      );
    }
    const problem = checkTransition(task.status, input.to, input.actor);
    if (problem) throw new InvalidTransitionError(task.status, input.to, problem);

    // Transaction-local flag that the guard trigger checks.
    await tx.execute(sql`select set_config('app.task_transition', 'on', true)`);
    const [updated] = await tx
      .update(tasks)
      .set({
        status: input.to,
        version: sql`${tasks.version} + 1`,
        statusChangedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, task.id))
      .returning({ version: tasks.version });
    await tx.execute(sql`select set_config('app.task_transition', '', true)`);

    await tx.insert(auditLog).values({
      brandId: task.brandId,
      taskId: task.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: 'status_changed',
      fromStatus: task.status,
      toStatus: input.to,
      details: { reason: input.reason ?? null, ...(input.details ?? {}) },
    });

    return { changed: true, from: task.status, to: input.to, version: updated!.version };
  });
}

export interface CreateTaskInput {
  brandId: string;
  kind: string;
  title: string;
  brief?: Record<string, unknown>;
  budgetUsd: number;
  parentId?: string;
  actor: Actor;
}

export async function createTask(db: DbOrTx, input: CreateTaskInput): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({
        brandId: input.brandId,
        kind: input.kind,
        title: input.title,
        brief: input.brief ?? {},
        budgetUsd: input.budgetUsd.toFixed(8),
        parentId: input.parentId ?? null,
      })
      .returning({ id: tasks.id });
    await tx.insert(auditLog).values({
      brandId: input.brandId,
      taskId: task!.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: 'task_created',
      toStatus: 'draft',
      details: { kind: input.kind, title: input.title, budgetUsd: input.budgetUsd },
    });
    return { id: task!.id };
  });
}

/** Pause is orthogonal to status. Idempotent: pausing a paused task keeps the first reason. */
export async function pauseTask(
  db: DbOrTx,
  taskId: string,
  reason: string,
  actor: Actor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set({ pausedAt: sql`now()`, pauseReason: reason, updatedAt: sql`now()` })
      .where(sql`${tasks.id} = ${taskId} and ${tasks.pausedAt} is null`)
      .returning({ brandId: tasks.brandId });
    if (!row) return false;
    await tx.insert(auditLog).values({
      brandId: row.brandId,
      taskId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'task_paused',
      details: { reason },
    });
    return true;
  });
}

/** Only a human can resume a paused task. */
export async function resumeTask(db: DbOrTx, taskId: string, actor: Actor): Promise<boolean> {
  if (actor.kind !== 'human') {
    throw new PermanentError('resume_requires_human', 'Only a human can resume a paused task');
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ brandId: tasks.brandId, reason: tasks.pauseReason })
      .from(tasks)
      .where(sql`${tasks.id} = ${taskId} and ${tasks.pausedAt} is not null`)
      .for('update');
    if (!row) return false;
    await tx
      .update(tasks)
      .set({ pausedAt: null, pauseReason: null, updatedAt: sql`now()` })
      .where(eq(tasks.id, taskId));
    await tx.insert(auditLog).values({
      brandId: row.brandId,
      taskId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'task_resumed',
      details: { previousReason: row.reason },
    });
    return true;
  });
}
