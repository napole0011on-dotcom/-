import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError, PermanentError } from '@cms/core';
import { schema, sql } from '@cms/db';
import { HUMAN, SYSTEM, seedBrand, seedTask, setupTestDb, type TestDb } from './testkit.js';
import { createTask, pauseTask, resumeTask, transitionTask } from './transitions.js';

const AGENT = { kind: 'agent', id: 'ceo' } as const;

/** Drizzle wraps driver errors; the Postgres message is in `cause`. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return err.cause?.message ?? err.message;
  }
  throw new Error('expected the query to fail');
}

describe('task transitions (Postgres)', () => {
  let t: TestDb;
  let brandId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    brandId = (await seedBrand(t.db)).id;
  });
  afterAll(async () => t?.close());

  const audit = (taskId: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.taskId} = ${taskId}`)
      .orderBy(schema.auditLog.id);
  const statusOf = async (taskId: string) =>
    (
      await t.db
        .select({ s: schema.tasks.status, v: schema.tasks.version })
        .from(schema.tasks)
        .where(sql`${schema.tasks.id} = ${taskId}`)
    )[0]!;

  it('walks the full lifecycle and writes one audit entry per change', async () => {
    const { id } = await createTask(t.db, {
      brandId,
      kind: 'content_week',
      title: 'Week',
      budgetUsd: 2,
      actor: HUMAN,
    });
    const steps = [
      ['planned', AGENT],
      ['awaiting_plan_approval', AGENT],
      ['in_progress', HUMAN],
      ['in_review', AGENT],
      ['revision', AGENT],
      ['in_review', AGENT],
      ['awaiting_final_approval', AGENT],
      ['approved', HUMAN],
      ['exported', SYSTEM],
    ] as const;
    for (const [to, actor] of steps) {
      const r = await transitionTask(t.db, { taskId: id, to, actor, reason: 'test' });
      expect(r.changed).toBe(true);
    }
    expect(await statusOf(id)).toEqual({ s: 'exported', v: 1 + steps.length });

    const log = await audit(id);
    expect(log.map((e) => e.action)).toEqual([
      'task_created',
      ...steps.map(() => 'status_changed'),
    ]);
    expect(log[3]).toMatchObject({
      fromStatus: 'awaiting_plan_approval',
      toStatus: 'in_progress',
      actorKind: 'human',
      actorId: 'tg:1',
    });
  });

  it('rejects an invalid transition and leaves no trace', async () => {
    const id = await seedTask(t.db, brandId);
    const before = (await audit(id)).length;
    await expect(
      transitionTask(t.db, { taskId: id, to: 'approved', actor: HUMAN }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await statusOf(id)).toMatchObject({ s: 'draft' });
    expect(await audit(id)).toHaveLength(before);
  });

  it('agents and the system cannot pass an approval gate', async () => {
    const id = await seedTask(t.db, brandId, { status: 'awaiting_final_approval' });
    for (const actor of [AGENT, SYSTEM]) {
      await expect(transitionTask(t.db, { taskId: id, to: 'approved', actor })).rejects.toThrow(
        /requires a human/,
      );
    }
    expect(await statusOf(id)).toMatchObject({ s: 'awaiting_final_approval' });
  });

  it('repeating a transition is a no-op (duplicate delivery / double click)', async () => {
    const id = await seedTask(t.db, brandId, { status: 'awaiting_plan_approval' });
    const first = await transitionTask(t.db, { taskId: id, to: 'in_progress', actor: HUMAN });
    const second = await transitionTask(t.db, { taskId: id, to: 'in_progress', actor: HUMAN });
    expect([first.changed, second.changed]).toEqual([true, false]);
    expect((await audit(id)).filter((e) => e.toStatus === 'in_progress')).toHaveLength(1);
  });

  it('concurrent identical transitions change the status exactly once', async () => {
    const id = await seedTask(t.db, brandId, { status: 'awaiting_plan_approval' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        transitionTask(t.db, { taskId: id, to: 'in_progress', actor: HUMAN }),
      ),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await audit(id)).filter((e) => e.toStatus === 'in_progress')).toHaveLength(1);
  });

  it('expectedFrom protects against acting on a stale view', async () => {
    const id = await seedTask(t.db, brandId, { status: 'in_progress' });
    await expect(
      transitionTask(t.db, { taskId: id, to: 'in_review', actor: AGENT, expectedFrom: 'revision' }),
    ).rejects.toThrow(/expected current status revision/);
  });

  it('the database refuses status changes that bypass transitionTask()', async () => {
    const id = await seedTask(t.db, brandId);
    expect(
      await pgError(
        t.db
          .update(schema.tasks)
          .set({ status: 'approved' })
          .where(sql`${schema.tasks.id} = ${id}`),
      ),
    ).toMatch(/must be changed via transitionTask/);
    // Other columns stay editable.
    await t.db
      .update(schema.tasks)
      .set({ title: 'Renamed' })
      .where(sql`${schema.tasks.id} = ${id}`);
  });

  it('audit_log is append-only', async () => {
    const id = await seedTask(t.db, brandId);
    expect(
      await pgError(
        t.db
          .update(schema.auditLog)
          .set({ action: 'x' })
          .where(sql`${schema.auditLog.taskId} = ${id}`),
      ),
    ).toMatch(/append-only/);
    expect(
      await pgError(t.db.delete(schema.auditLog).where(sql`${schema.auditLog.taskId} = ${id}`)),
    ).toMatch(/append-only/);
  });

  it('pause/resume: idempotent pause, only a human resumes, both audited', async () => {
    const id = await seedTask(t.db, brandId, { status: 'in_progress' });
    expect(await pauseTask(t.db, id, 'budget:day', SYSTEM)).toBe(true);
    expect(await pauseTask(t.db, id, 'other', SYSTEM)).toBe(false);
    await expect(resumeTask(t.db, id, SYSTEM)).rejects.toBeInstanceOf(PermanentError);
    expect(await resumeTask(t.db, id, HUMAN)).toBe(true);
    expect(await resumeTask(t.db, id, HUMAN)).toBe(false);
    const actions = (await audit(id)).map((e) => e.action);
    expect(actions.filter((a) => a === 'task_paused')).toHaveLength(1);
    expect(actions.filter((a) => a === 'task_resumed')).toHaveLength(1);
    expect(await statusOf(id)).toMatchObject({ s: 'in_progress' });
  });
});
