import { PermanentError, type Actor } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';
import { withIdempotency } from './idempotency.js';

const { artifacts, approvals, auditLog } = schema;

export type Artifact = typeof artifacts.$inferSelect;

export interface NewArtifact {
  brandId: string;
  taskId: string;
  runId: string | null;
  slot: string;
  kind: string;
  content: Record<string, unknown>;
  agent: string;
  promptVersion: string;
  model: string | null;
  storageKey?: string | null;
}

/**
 * Appends a new version to a slot (v1, v2, ...). Old versions are never modified.
 * The same idempotency key returns the version created the first time, so a retried
 * run does not produce duplicate versions.
 */
export async function createArtifactVersion(
  db: DbOrTx,
  idempotencyKey: string,
  a: NewArtifact,
): Promise<Artifact> {
  const { result } = await withIdempotency(db, `artifact:${idempotencyKey}`, async () =>
    db.transaction(async (tx) => {
      // Serialise version numbering per (task, slot).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`artifact:${a.taskId}:${a.slot}`}))`,
      );
      const [row] = await tx
        .select({ v: sql<number>`coalesce(max(${artifacts.version}), 0)` })
        .from(artifacts)
        .where(sql`${artifacts.taskId} = ${a.taskId} and ${artifacts.slot} = ${a.slot}`);
      const [created] = await tx
        .insert(artifacts)
        .values({ ...a, storageKey: a.storageKey ?? null, version: Number(row!.v) + 1 })
        .returning();
      return { id: created!.id };
    }),
  );
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.id} = ${result.id}`);
  return artifact!;
}

export async function getArtifact(db: DbOrTx, id: string): Promise<Artifact | undefined> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.id} = ${id}`);
  return row;
}

/** Latest version of every slot of a task matching a prefix, e.g. "copy:". */
export async function latestArtifacts(
  db: DbOrTx,
  taskId: string,
  slotPrefix: string,
): Promise<Artifact[]> {
  return db
    .selectDistinctOn([artifacts.slot])
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId} and ${artifacts.slot} like ${slotPrefix + '%'}`)
    .orderBy(artifacts.slot, sql`${artifacts.version} desc`);
}

export async function latestArtifact(
  db: DbOrTx,
  taskId: string,
  slot: string,
): Promise<Artifact | undefined> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId} and ${artifacts.slot} = ${slot}`)
    .orderBy(sql`${artifacts.version} desc`)
    .limit(1);
  return row;
}

export async function artifactHistory(
  db: DbOrTx,
  taskId: string,
  slot: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId} and ${artifacts.slot} = ${slot}`)
    .orderBy(artifacts.version);
}

export type Decision = (typeof approvals.$inferInsert)['decision'];
export type Gate = (typeof approvals.$inferInsert)['gate'];

export interface DecisionInput {
  brandId: string;
  taskId: string;
  gate: Gate;
  decision: Decision;
  actor: Actor;
  artifact?: Pick<Artifact, 'id' | 'version'> | null;
  comment?: string | null;
  choice?: number | null;
  /** One decision per key: pressing a button twice records it once. */
  idempotencyKey: string;
}

/** Records a human decision (with time and artifact version) plus an audit entry. */
export async function recordDecision(
  db: DbOrTx,
  d: DecisionInput,
): Promise<{ recorded: boolean; id: string }> {
  if (d.actor.kind !== 'human') {
    throw new PermanentError(
      'decision_requires_human',
      'Approval decisions can only be made by a human',
    );
  }
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(approvals)
      .values({
        brandId: d.brandId,
        taskId: d.taskId,
        gate: d.gate,
        decision: d.decision,
        artifactId: d.artifact?.id ?? null,
        artifactVersion: d.artifact?.version ?? null,
        comment: d.comment ?? null,
        choice: d.choice ?? null,
        decidedBy: d.actor.id,
        idempotencyKey: d.idempotencyKey,
      })
      .onConflictDoNothing({ target: approvals.idempotencyKey })
      .returning({ id: approvals.id });
    if (!inserted) {
      const [existing] = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(sql`${approvals.idempotencyKey} = ${d.idempotencyKey}`);
      return { recorded: false, id: existing!.id };
    }
    await tx.insert(auditLog).values({
      brandId: d.brandId,
      taskId: d.taskId,
      actorKind: d.actor.kind,
      actorId: d.actor.id,
      action: `decision:${d.gate}:${d.decision}`,
      details: {
        approvalId: inserted.id,
        artifactId: d.artifact?.id ?? null,
        artifactVersion: d.artifact?.version ?? null,
        comment: d.comment ?? null,
        choice: d.choice ?? null,
      },
    });
    return { recorded: true, id: inserted.id };
  });
}

/** Final-gate decisions per artifact id (exact version). */
export async function finalDecisions(
  db: DbOrTx,
  taskId: string,
): Promise<Map<string, { decision: Decision; choice: number | null; comment: string | null }>> {
  const rows = await db
    .select({
      id: approvals.artifactId,
      decision: approvals.decision,
      choice: approvals.choice,
      comment: approvals.comment,
    })
    .from(approvals)
    .where(
      sql`${approvals.taskId} = ${taskId} and ${approvals.gate} = 'final' and ${approvals.artifactId} is not null`,
    );
  return new Map(
    rows.map((r) => [r.id!, { decision: r.decision, choice: r.choice, comment: r.comment }]),
  );
}
