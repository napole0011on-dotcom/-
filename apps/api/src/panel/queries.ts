import {
  checkTransition,
  unpricedModels,
  type AppConfig,
  type ModelPricing,
  type TaskStatus,
} from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import { budgetStatus, finalDecisions, latestArtifacts, type BudgetContext } from '@cms/engine';
import {
  AGENTS,
  CeoPlan,
  briefText,
  estimatePlan,
  loadPrompt,
  toItemView,
  type CopyContent,
} from '@cms/agents';

const {
  tasks,
  runs,
  artifacts,
  approvals,
  auditLog,
  agentInvocations,
  costRecords,
  llmCalls,
  walletSnapshots,
} = schema;

export interface QueryDeps {
  db: Db;
  config: AppConfig;
  pricing: ModelPricing;
  budget: BudgetContext;
  brandId: () => string;
}

const HUMAN = { kind: 'human', id: 'panel:owner' } as const;
const num = (v: string | number | null | undefined) => Number(v ?? 0);

/** Active provider and models: shown in the header and on every agent card. */
export function llmStatus(d: QueryDeps) {
  const { llm } = d.config;
  const models = Object.values(llm.models);
  return {
    provider: llm.provider,
    gatewayHost: llm.baseUrl ? new URL(llm.baseUrl).host : null,
    structuredOutputs: llm.structuredOutputs,
    rateLimit: llm.rateLimit,
    costSafetyFactor: llm.costSafetyFactor,
    models: llm.models,
    unpricedModels: llm.provider === 'mock' ? [] : unpricedModels(d.pricing, models),
    budget: {
      dailyUsd: d.config.budget.dailyUsd,
      monthlyUsd: d.config.budget.monthlyUsd,
      taskUsd: d.config.budget.taskUsd,
    },
  };
}

export type AgentStatus = 'idle' | 'working' | 'waiting_approval' | 'error' | 'paused';

export async function agentCards(d: QueryDeps) {
  const { db, config } = d;
  const tz = config.timezone;
  const staleSeconds = config.queue.runStaleAfterSeconds;
  const waitingPlan = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(sql`${tasks.status} = 'awaiting_plan_approval'`)
    .orderBy(tasks.statusChangedAt)
    .limit(1);
  const waitingFinal = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(sql`${tasks.status} = 'awaiting_final_approval'`)
    .orderBy(tasks.statusChangedAt)
    .limit(1);

  const cards = [];
  for (const def of AGENTS) {
    const [running] = await db
      .select({
        taskId: agentInvocations.taskId,
        title: tasks.title,
        startedAt: agentInvocations.startedAt,
        runId: agentInvocations.runId,
      })
      .from(agentInvocations)
      .leftJoin(tasks, sql`${tasks.id} = ${agentInvocations.taskId}`)
      .where(
        sql`${agentInvocations.agent} = ${def.id} and ${agentInvocations.status} = 'running' and ${agentInvocations.startedAt} > now() - make_interval(secs => ${staleSeconds})`,
      )
      .orderBy(sql`${agentInvocations.startedAt} desc`)
      .limit(1);
    const [last] = await db
      .select({
        status: agentInvocations.status,
        startedAt: agentInvocations.startedAt,
        finishedAt: agentInvocations.finishedAt,
        runId: agentInvocations.runId,
      })
      .from(agentInvocations)
      .where(sql`${agentInvocations.agent} = ${def.id}`)
      .orderBy(sql`${agentInvocations.startedAt} desc`)
      .limit(1);
    const [stats] = await db
      .select({
        ok: sql<string>`count(*) filter (where ${agentInvocations.status} = 'succeeded')`,
        failed: sql<string>`count(*) filter (where ${agentInvocations.status} = 'failed')`,
      })
      .from(agentInvocations)
      .where(
        sql`${agentInvocations.agent} = ${def.id} and ${agentInvocations.startedAt} > now() - interval '30 days'`,
      );
    const [spend] = await db
      .select({ usd: sql<string>`coalesce(sum(${costRecords.costUsd}), 0)` })
      .from(costRecords)
      .where(
        sql`${costRecords.agent} = ${def.id} and ${costRecords.status} = 'final' and (${costRecords.createdAt} at time zone ${tz})::date = (now() at time zone ${tz})::date`,
      );

    const waiting = def.id === 'ceo' ? waitingPlan[0] : waitingFinal[0];
    const recentError =
      last?.status === 'failed' && last.startedAt.getTime() > Date.now() - 24 * 3_600_000;
    const status: AgentStatus = running
      ? 'working'
      : waiting
        ? 'waiting_approval'
        : recentError
          ? 'error'
          : 'idle';
    const ok = num(stats?.ok);
    const failed = num(stats?.failed);
    cards.push({
      id: def.id,
      name: def.name,
      role: def.role,
      description: def.description,
      status,
      currentTask: running
        ? {
            id: running.taskId,
            title: running.title,
            since: running.startedAt,
            runId: running.runId,
          }
        : waiting
          ? { id: waiting.id, title: waiting.title, since: null, runId: null }
          : null,
      lastRunAt: last?.startedAt ?? null,
      lastRunId: last?.runId ?? null,
      success: { ok, failed, rate: ok + failed > 0 ? ok / (ok + failed) : null },
      spentTodayUsd: num(spend?.usd),
      model: {
        name: config.llm.models[def.modelRole],
        role: def.modelRole,
        source: '.env' as const,
      },
      promptVersion: loadPrompt(def.prompt).version,
    });
  }
  return cards;
}

const spentByTask = (db: Db, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve(new Map<string, number>())
    : db
        .select({
          taskId: costRecords.taskId,
          usd: sql<string>`coalesce(sum(case when ${costRecords.status} = 'final' then ${costRecords.costUsd} else 0 end), 0)`,
        })
        .from(costRecords)
        .where(sql`${costRecords.taskId} in ${ids}`)
        .groupBy(costRecords.taskId)
        .then((rows) => new Map(rows.map((r) => [r.taskId!, num(r.usd)])));

export async function taskBoard(d: QueryDeps) {
  const rows = await d.db
    .select()
    .from(tasks)
    .where(sql`${tasks.kind} <> 'smoke'`)
    .orderBy(sql`${tasks.statusChangedAt} desc`)
    .limit(200);
  const spent = await spentByTask(
    d.db,
    rows.map((r) => r.id),
  );
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    paused: t.pausedAt !== null,
    pauseReason: t.pauseReason,
    createdAt: t.createdAt,
    statusChangedAt: t.statusChangedAt,
    spentUsd: spent.get(t.id) ?? 0,
  }));
}

/** Which buttons the panel may show for a task (the server re-checks on every action). */
export function allowedActions(status: TaskStatus) {
  const can = (to: TaskStatus) => checkTransition(status, to, HUMAN) === null;
  return {
    decidePlan: status === 'awaiting_plan_approval',
    decideItems: ['awaiting_final_approval', 'revision', 'in_review'].includes(status),
    rejectPackage: status === 'awaiting_final_approval',
    reopenPackage: status === 'rejected' && can('awaiting_final_approval'),
    cancel: can('cancelled'),
  };
}

export async function taskDetail(d: QueryDeps, taskId: string) {
  const { db } = d;
  const [t] = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.id} = ${taskId}`);
  if (!t) return null;
  const arts = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId}`)
    .orderBy(artifacts.slot, artifacts.version);
  const decisions = await db
    .select()
    .from(approvals)
    .where(sql`${approvals.taskId} = ${taskId}`)
    .orderBy(approvals.createdAt);
  const audit = await db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.taskId} = ${taskId}`)
    .orderBy(auditLog.id);
  const runRows = await db
    .select({
      id: runs.id,
      agent: runs.agent,
      status: runs.status,
      attempt: runs.attempt,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
      error: runs.error,
    })
    .from(runs)
    .where(sql`${runs.taskId} = ${taskId}`)
    .orderBy(runs.createdAt);
  const spent = (await budgetStatus(db, d.budget, t.brandId, t.id)).find(
    (s) => s.scope === 'task',
  )!;
  const decisionByArtifact = new Map(
    decisions.filter((x) => x.artifactId).map((x) => [x.artifactId!, x]),
  );

  return {
    task: {
      id: t.id,
      title: t.title,
      status: t.status,
      brief: briefText(t),
      paused: t.pausedAt !== null,
      pauseReason: t.pauseReason,
      createdAt: t.createdAt,
      statusChangedAt: t.statusChangedAt,
      spentUsd: spent.spentUsd,
      budgetUsd: spent.limitUsd,
    },
    actions: allowedActions(t.status),
    plans: arts
      .filter((a) => a.slot === 'plan')
      .map((a) => ({
        id: a.id,
        version: a.version,
        createdAt: a.createdAt,
        promptVersion: a.promptVersion,
        model: a.model,
        plan: CeoPlan.parse(a.content),
      })),
    copies: arts
      .filter((a) => a.slot.startsWith('copy:'))
      .map((a) => {
        const dec = decisionByArtifact.get(a.id);
        return {
          ...toItemView(a),
          slot: a.slot,
          createdAt: a.createdAt,
          runId: a.runId,
          promptVersion: a.promptVersion,
          model: a.model,
          decision: dec
            ? {
                decision: dec.decision,
                choice: dec.choice,
                comment: dec.comment,
                by: dec.decidedBy,
                at: dec.createdAt,
              }
            : null,
        };
      }),
    decisions: decisions.map((x) => ({
      gate: x.gate,
      decision: x.decision,
      artifactVersion: x.artifactVersion,
      choice: x.choice,
      comment: x.comment,
      by: x.decidedBy,
      at: x.createdAt,
    })),
    history: audit.map((a) => ({
      at: a.createdAt,
      actor: `${a.actorKind}:${a.actorId}`,
      action: a.action,
      from: a.fromStatus,
      to: a.toStatus,
    })),
    runs: runRows.map((r) => ({ ...r, error: r.error as { message?: string } | null })),
  };
}

export async function approvalQueue(d: QueryDeps) {
  const { db } = d;
  const plans = [];
  for (const t of await db
    .select()
    .from(tasks)
    .where(sql`${tasks.status} = 'awaiting_plan_approval'`)
    .orderBy(tasks.statusChangedAt)) {
    const [a] = await db
      .select()
      .from(artifacts)
      .where(sql`${artifacts.taskId} = ${t.id} and ${artifacts.slot} = 'plan'`)
      .orderBy(sql`${artifacts.version} desc`)
      .limit(1);
    if (!a) continue;
    const plan = CeoPlan.parse(a.content);
    const spent = (await budgetStatus(db, d.budget, t.brandId, t.id)).find(
      (s) => s.scope === 'task',
    )!;
    plans.push({
      taskId: t.id,
      title: t.title,
      waitingSince: t.statusChangedAt,
      planArtifactId: a.id,
      version: a.version,
      plan,
      estimate: estimatePlan(plan, d.pricing, d.config.llm.models),
      spentUsd: spent.spentUsd,
      taskBudgetUsd: spent.limitUsd,
    });
  }

  const packages = [];
  for (const t of await db
    .select()
    .from(tasks)
    .where(sql`${tasks.status} in ('awaiting_final_approval', 'revision', 'in_review')`)
    .orderBy(tasks.statusChangedAt)) {
    const latest = await latestArtifacts(db, t.id, 'copy:');
    if (latest.length === 0) continue;
    const decided = await finalDecisions(db, t.id);
    const pending = latest.filter(
      (a) => decided.get(a.id)?.decision !== 'approved' && !decided.has(a.id),
    );
    packages.push({
      taskId: t.id,
      title: t.title,
      status: t.status,
      waitingSince: t.statusChangedAt,
      totalCount: latest.length,
      pendingCount: latest.filter((a) => decided.get(a.id)?.decision !== 'approved').length,
      canReject: t.status === 'awaiting_final_approval',
      items: pending.map((a) => ({ ...toItemView(a), promptVersion: a.promptVersion })),
    });
  }
  return {
    plans,
    packages,
    count: plans.length + packages.reduce((n, p) => n + p.items.length, 0),
  };
}

export async function runCard(d: QueryDeps, runId: string) {
  const { db } = d;
  const [r] = await db
    .select()
    .from(runs)
    .where(sql`${runs.id} = ${runId}`);
  if (!r) return null;
  const [t] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(sql`${tasks.id} = ${r.taskId}`);
  const invocations = await db
    .select()
    .from(agentInvocations)
    .where(sql`${agentInvocations.runId} = ${runId}`)
    .orderBy(agentInvocations.startedAt);
  const calls = await db
    .select({
      id: llmCalls.id,
      agent: llmCalls.agent,
      promptVersion: llmCalls.promptVersion,
      requestedModel: llmCalls.requestedModel,
      servedModel: llmCalls.servedModel,
      attempt: llmCalls.attempt,
      status: llmCalls.status,
      stopReason: llmCalls.stopReason,
      inputTokens: llmCalls.inputTokens,
      outputTokens: llmCalls.outputTokens,
      cacheReadTokens: llmCalls.cacheReadTokens,
      cacheWriteTokens: llmCalls.cacheWriteTokens,
      costUsd: llmCalls.costUsd,
      latencyMs: llmCalls.latencyMs,
      createdAt: llmCalls.createdAt,
      hasFullText: sql<boolean>`${llmCalls.request} is not null`,
      error: llmCalls.error,
    })
    .from(llmCalls)
    .where(sql`${llmCalls.runId} = ${runId}`)
    .orderBy(llmCalls.createdAt);
  const arts = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.runId} = ${runId}`)
    .orderBy(artifacts.createdAt);
  return {
    run: {
      id: r.id,
      agent: r.agent,
      status: r.status,
      attempt: r.attempt,
      input: r.input,
      output: r.output,
      error: r.error,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    },
    task: t ?? null,
    invocations: invocations.map((i) => ({
      agent: i.agent,
      status: i.status,
      promptVersion: i.promptVersion,
      model: i.model,
      costUsd: num(i.costUsd),
      latencyMs: i.latencyMs,
      startedAt: i.startedAt,
      error: i.error,
    })),
    llmCalls: calls.map((c) => ({ ...c, costUsd: num(c.costUsd) })),
    artifacts: arts.map((a) => ({
      id: a.id,
      slot: a.slot,
      version: a.version,
      promptVersion: a.promptVersion,
      critic: a.slot.startsWith('copy:') ? (a.content as CopyContent).critic : null,
    })),
  };
}

/** Full request/response of one LLM call (only stored when LLM_STORE_FULL_TEXT=true). */
export async function llmCallText(d: QueryDeps, id: string) {
  const [c] = await d.db
    .select({ request: llmCalls.request, response: llmCalls.response })
    .from(llmCalls)
    .where(sql`${llmCalls.id} = ${id}`);
  return c ?? null;
}

export async function spendOverview(d: QueryDeps) {
  const { db, config } = d;
  const brandId = d.brandId();
  const tz = config.timezone;
  const status = await budgetStatus(db, d.budget, brandId, null);
  const day = status.find((s) => s.scope === 'day')!;
  const month = status.find((s) => s.scope === 'month')!;
  const byAgent = await db
    .select({
      agent: costRecords.agent,
      today: sql<string>`coalesce(sum(${costRecords.costUsd}) filter (where (${costRecords.createdAt} at time zone ${tz})::date = (now() at time zone ${tz})::date), 0)`,
      month: sql<string>`coalesce(sum(${costRecords.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(costRecords)
    .where(
      sql`${costRecords.brandId} = ${brandId} and ${costRecords.status} = 'final' and to_char(${costRecords.createdAt} at time zone ${tz}, 'YYYY-MM') = to_char(now() at time zone ${tz}, 'YYYY-MM')`,
    )
    .groupBy(costRecords.agent);
  const pausedTasks = await db
    .select({ id: tasks.id, title: tasks.title, reason: tasks.pauseReason })
    .from(tasks)
    .where(sql`${tasks.pausedAt} is not null and ${tasks.pauseReason} like 'budget:%'`);
  const reconciliations = await db
    .select()
    .from(walletSnapshots)
    .where(sql`${walletSnapshots.brandId} = ${brandId}`)
    .orderBy(sql`${walletSnapshots.createdAt} desc`)
    .limit(10);
  const warnRatio = config.budget.warnRatio;
  const level = (spent: number, limit: number) =>
    limit > 0 && spent >= limit ? 'over' : limit > 0 && spent >= limit * warnRatio ? 'warn' : 'ok';
  return {
    warnRatio,
    day: { ...day, level: level(day.spentUsd, day.limitUsd) },
    month: { ...month, level: level(month.spentUsd, month.limitUsd) },
    taskLimitUsd: config.budget.taskUsd,
    byAgent: byAgent.map((a) => ({
      agent: a.agent,
      todayUsd: num(a.today),
      monthUsd: num(a.month),
      calls: num(a.calls),
    })),
    pausedTasks,
    reconciliations: reconciliations.map((r) => ({
      at: r.createdAt,
      provider: r.provider,
      balanceUsd: num(r.balanceUsd),
      walletSpentUsd: r.walletSpentUsd === null ? null : num(r.walletSpentUsd),
      recordedRawUsd: num(r.recordedRawUsd),
    })),
  };
}
