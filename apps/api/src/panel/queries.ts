import {
  checkTransition,
  unpricedModels,
  type AppConfig,
  type ModelPricing,
  type TaskStatus,
} from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import { toolInfo } from './media-routes.js';
import {
  PROVIDER_LABEL,
  budgetStatus,
  finalDecisions,
  latestArtifacts,
  type BudgetContext,
} from '@cms/engine';
import {
  CeoPlan,
  TEST_TASK_KIND,
  activationProblems,
  agentsForRun,
  constructorSpecOf,
  listAgents,
  specHash,
  briefText,
  estimatePlan,
  getControlState,
  linkActive,
  loadWorkspace,
  deleteLinkProblem,
  promptHistory,
  recentEvents,
  toItemView,
  toNodeView,
  type NodeContent,
  type Pipeline,
  type AgentControls,
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
  controls: AgentControls;
}

/** Tasks that never show on the board: smoke tests and agent test runs. */
const HIDDEN_KINDS = ['smoke', TEST_TASK_KIND, 'media', 'mailing'];

/** Runs held in the queue for a paused agent / "stop everything", by task. */
async function heldRuns(db: Db) {
  return db
    .select({ id: runs.id, taskId: runs.taskId, input: runs.input, waitingFor: runs.waitingFor })
    .from(runs)
    .where(sql`${runs.status} = 'queued' and ${runs.waitingFor} is not null`);
}

/** "agent:copywriter" -> "Копирайтер", "all" -> "все агенты остановлены". */
export function waitingLabel(waitingFor: string, names: Record<string, string> = {}): string {
  if (waitingFor === 'all') return 'все агенты остановлены';
  if (waitingFor.startsWith('provider:'))
    return `ждёт провайдера: ${PROVIDER_LABEL[waitingFor.slice(9)] ?? waitingFor.slice(9)}`;
  const id = waitingFor.replace(/^agent:/, '');
  return names[id] ?? id;
}

/** Agent id -> name for labels (code and registry agents). */
export async function agentNames(d: Pick<QueryDeps, 'db' | 'brandId'>) {
  return Object.fromEntries(
    (await listAgents(d.db, d.brandId())).map((a) => [a.id, a.name] as const),
  );
}

const HUMAN = { kind: 'human', id: 'panel:owner' } as const;
const num = (v: string | number | null | undefined) => Number(v ?? 0);

/** Active provider and models (with panel overrides): shown in the header. */
export async function llmStatus(d: QueryDeps) {
  const { llm } = d.config;
  const effective = await d.controls.effectiveModels(d.brandId());
  const models = Object.values(effective);
  const controls = await getControlState(d.db, d.brandId());
  const [h] = await d.db
    .select()
    .from(schema.providerStatus)
    .where(sql`${schema.providerStatus.provider} = ${llm.provider}`);
  const retryIn =
    h?.state === 'down' && h.openUntil
      ? Math.max(0, Math.ceil((h.openUntil.getTime() - Date.now()) / 1000))
      : null;
  return {
    provider: llm.provider,
    // Circuit breaker state written by the worker: ok | degraded | down.
    health: {
      state: llm.provider === 'mock' ? 'ok' : (h?.state ?? 'ok'),
      retryInSeconds: retryIn,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      lastError: (h?.lastError as Record<string, unknown> | null) ?? null,
      lastErrorAt: h?.lastErrorAt ?? null,
      lastOkAt: h?.lastOkAt ?? null,
    },
    gatewayHost: llm.baseUrl ? new URL(llm.baseUrl).host : null,
    structuredOutputs: llm.structuredOutputs,
    rateLimit: llm.rateLimit,
    costSafetyFactor: llm.costSafetyFactor,
    models: effective,
    controls: {
      allPaused: controls.allPaused,
      changedAt: controls.changedAt,
      changedBy: controls.changedBy,
    },
    unpricedModels: llm.provider === 'mock' ? [] : unpricedModels(d.pricing, models),
    budget: {
      dailyUsd: d.config.budget.dailyUsd,
      monthlyUsd: d.config.budget.monthlyUsd,
      taskUsd: d.config.budget.taskUsd,
    },
  };
}

export type AgentStatus = 'idle' | 'working' | 'waiting_approval' | 'error' | 'paused' | 'disabled';

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

  const brandId = d.brandId();
  const controls = await getControlState(db, brandId);
  const held = await heldRuns(db);

  const cards = [];
  for (const def of await listAgents(db, brandId)) {
    const ctl = controls.agents[def.id] ?? {
      paused: false,
      disabled: false,
      modelOverride: null,
      updatedBy: null,
      updatedAt: null,
    };
    const history = def.promptAgent ? await promptHistory(db, brandId, def.promptAgent) : null;
    const model = await d.controls.modelOf(brandId, def);
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

    // The owner's gates belong to the planner (plan) and to the working pipeline (package).
    const waiting = !def.code ? undefined : def.id === 'ceo' ? waitingPlan[0] : waitingFinal[0];
    const recentError =
      last?.status === 'failed' && last.startedAt.getTime() > Date.now() - 24 * 3_600_000;
    const paused = ctl.paused || controls.allPaused;
    // A run that already started is finished even when the agent is paused.
    const status: AgentStatus = ctl.disabled
      ? 'disabled'
      : running
        ? 'working'
        : paused
          ? 'paused'
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
      kind: def.kind,
      registryStatus: def.status,
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
      runs30: ok + failed,
      spentTodayUsd: num(spend?.usd),
      model: {
        name: model.name,
        env: model.env,
        role: def.modelRole,
        source: model.source,
        ignoredOverride: model.ignoredOverride,
      },
      promptVersion: history?.active?.label ?? null,
      pendingFilePrompt: history?.pendingFile?.label ?? null,
      controls: {
        paused: ctl.paused,
        disabled: ctl.disabled,
        allPaused: controls.allPaused,
        updatedAt: ctl.updatedAt,
        updatedBy: ctl.updatedBy,
      },
      // Runs held because of THIS agent (or "stop everything" when it needs this agent).
      waitingRuns: held.filter(
        (r) =>
          r.waitingFor === `agent:${def.id}` ||
          (r.waitingFor === 'all' && agentsForRun(r).includes(def.id)),
      ).length,
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
    .where(sql`${tasks.kind} not in ${HIDDEN_KINDS}`)
    .orderBy(sql`${tasks.statusChangedAt} desc`)
    .limit(200);
  const spent = await spentByTask(
    d.db,
    rows.map((r) => r.id),
  );
  const held = await heldRuns(d.db);
  const names = await agentNames(d);
  const waitingOf = (taskId: string) => {
    const r = held.find((h) => h.taskId === taskId);
    return r?.waitingFor ? waitingLabel(r.waitingFor, names) : null;
  };
  return rows.map((t) => ({
    waitingFor: waitingOf(t.id),
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
  const names = await agentNames(d);
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
      waitingFor: runs.waitingFor,
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
      waitingFor: (() => {
        const w = runRows.find((r) => r.status === 'queued' && r.waitingFor)?.waitingFor;
        return w ? waitingLabel(w, names) : null;
      })(),
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
    nodes: arts
      .filter((a) => a.slot.startsWith('node:'))
      .map((a) => {
        const dec = decisionByArtifact.get(a.id);
        return {
          ...toNodeView(a),
          slot: a.slot,
          createdAt: a.createdAt,
          runId: a.runId,
          promptVersion: a.promptVersion,
          model: a.model,
          decision: dec
            ? { decision: dec.decision, comment: dec.comment, by: dec.decidedBy, at: dec.createdAt }
            : null,
        };
      }),
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
      estimate: estimatePlan(plan, d.pricing, await d.controls.effectiveModels(t.brandId)),
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
    const copies = await latestArtifacts(db, t.id, 'copy:');
    if (copies.length === 0) continue;
    const nodes = await latestArtifacts(db, t.id, 'node:');
    const latest = [...copies, ...nodes];
    const decided = await finalDecisions(db, t.id);
    const undecided = (a: { id: string }) => !decided.has(a.id);
    packages.push({
      taskId: t.id,
      title: t.title,
      status: t.status,
      waitingSince: t.statusChangedAt,
      totalCount: latest.length,
      pendingCount: latest.filter((a) => decided.get(a.id)?.decision !== 'approved').length,
      canReject: t.status === 'awaiting_final_approval',
      items: copies
        .filter(undecided)
        .map((a) => ({ ...toItemView(a), promptVersion: a.promptVersion })),
      nodeItems: nodes
        .filter(undecided)
        .map((a) => ({ ...toNodeView(a), promptVersion: a.promptVersion })),
    });
  }
  return {
    plans,
    packages,
    count: plans.length + packages.reduce((n, p) => n + p.items.length + p.nodeItems.length, 0),
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

/** "Настроить" drawer: controls, model choice (price list only) and prompt versions. */
export async function agentSettingsView(d: QueryDeps, agentId: string) {
  const brandId = d.brandId();
  const def = await d.controls.agent(brandId, agentId);
  if (!def?.promptAgent) return null;
  const controls = await getControlState(d.db, brandId);
  const ctl = controls.agents[def.id] ?? {
    paused: false,
    disabled: false,
    updatedAt: null,
    updatedBy: null,
  };
  const model = await d.controls.modelOf(brandId, def);
  const prompts = await promptHistory(d.db, brandId, def.promptAgent);
  let constructor = null;
  if (def.kind === 'constructor') {
    const { spec, raw } = constructorSpecOf(def);
    const lastTest = (raw as { lastTest?: unknown }).lastTest ?? null;
    constructor = {
      fields: (raw as { fields?: unknown }).fields ?? [],
      criteria: (raw as { criteria?: unknown }).criteria ?? [],
      lastTest,
      specHash: spec ? specHash(spec) : null,
      activationProblems:
        def.status === 'active' ? [] : await activationProblems(d.db, brandId, def),
    };
  }
  return {
    agent: {
      id: def.id,
      name: def.name,
      role: def.role,
      description: def.description,
      kind: def.kind,
      status: def.status,
      color: def.color,
      icon: def.icon,
    },
    constructor,
    controls: {
      paused: ctl.paused,
      disabled: ctl.disabled,
      allPaused: controls.allPaused,
      updatedAt: ctl.updatedAt,
      updatedBy: ctl.updatedBy,
    },
    model: { ...model, role: def.modelRole ?? 'worker', allowed: d.controls.allowedModels() },
    prompts: {
      maxBytes: 32 * 1024,
      active: prompts.active,
      pendingFile: prompts.pendingFile,
      versions: prompts.versions,
    },
  };
}

/** The board: nodes (with live card data for working agents), links and positions. */
export async function workspaceView(d: QueryDeps) {
  const brandId = d.brandId();
  const ws = await loadWorkspace(d.db, brandId);
  const cards = await agentCards(d);
  const tools = toolInfo(d.config);
  return {
    nodes: ws.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      description: n.description,
      kind: n.kind,
      status: n.status,
      color: n.color,
      icon: n.icon,
      position: ws.layout[n.id] ?? { x: 0, y: 0 },
      card: cards.find((c) => c.id === n.id) ?? null,
      tool: tools[n.id] ?? null,
    })),
    links: ws.links.map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      kind: l.kind,
      active: linkActive(ws.nodes, l),
      deletable: deleteLinkProblem(l) === null,
    })),
  };
}

export async function eventsView(d: QueryDeps, afterId = 0) {
  return recentEvents(d.db, d.brandId(), 50, afterId);
}

export type StepState = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

/** "Задача" view of the board: which steps this task runs, their state, verdict and cost. */
export async function taskPath(d: QueryDeps, taskId: string) {
  const { db } = d;
  const [t] = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.id} = ${taskId}`);
  if (!t) return null;
  const [planArt] = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId} and ${artifacts.slot} = 'plan'`)
    .orderBy(sql`${artifacts.version} desc`)
    .limit(1);
  const pipeline = (planArt?.content as { pipeline?: Pipeline } | undefined)?.pipeline ?? null;
  const runRows = await db
    .select()
    .from(runs)
    .where(sql`${runs.taskId} = ${taskId}`);
  const inv = await db
    .select({
      agent: agentInvocations.agent,
      status: agentInvocations.status,
      cost: sql<string>`coalesce(sum(${agentInvocations.costUsd}), 0)`,
    })
    .from(agentInvocations)
    .where(sql`${agentInvocations.taskId} = ${taskId}`)
    .groupBy(agentInvocations.agent, agentInvocations.status);
  const costOf = (agent: string) =>
    inv.filter((i) => i.agent === agent).reduce((s2, i) => s2 + num(i.cost), 0);
  const arts = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.taskId} = ${taskId}`)
    .orderBy(sql`${artifacts.version} desc`);
  const verdictOf = (agent: string): boolean | null => {
    const mine = arts.filter((a) =>
      agent === 'copywriter' ? a.slot.startsWith('copy:') : a.slot === `node:${agent}:main`,
    );
    if (mine.length === 0) return null;
    const seen = new Set<string>();
    const latest = mine.filter((a) => !seen.has(a.slot) && seen.add(a.slot));
    const verdicts = latest.map((a) =>
      agent === 'copywriter'
        ? (a.content as CopyContent).critic.passed
        : ((a.content as NodeContent).critic?.passed ?? null),
    );
    return verdicts.some((v) => v === null) ? null : verdicts.every(Boolean);
  };
  const stateOf = (agent: string): StepState => {
    const mine = runRows.filter((r) => {
      const i = r.input as { kind?: string; agent?: string };
      if (agent === 'ceo') return i.kind === 'plan';
      if (agent === 'copywriter') return i.kind === 'copy' || i.kind === 'rework';
      return i.kind === 'node' && i.agent === agent;
    });
    if (mine.some((r) => r.status === 'running')) return 'running';
    if (mine.some((r) => r.status === 'queued'))
      return mine.some((r) => r.waitingFor) ? 'waiting' : 'running';
    if (mine.some((r) => r.status === 'failed' || r.status === 'dead')) return 'failed';
    return mine.some((r) => r.status === 'succeeded') ? 'done' : 'pending';
  };
  const agents = ['ceo', ...(pipeline?.steps.map((s2) => s2.agent) ?? ['copywriter'])];
  const reviewed = pipeline?.steps.some((s2) => s2.reviewed) ?? true;
  if (reviewed) agents.push('critic');
  return {
    taskId,
    title: t.title,
    status: t.status,
    pipeline,
    nodes: agents.map((agent) => ({
      agent,
      state: agent === 'critic' ? stateOf('copywriter') : stateOf(agent),
      verdict:
        agent === 'critic' ? verdictOf('copywriter') : agent === 'ceo' ? null : verdictOf(agent),
      costUsd: costOf(agent),
    })),
  };
}

/** «Ход задачи» and the replay: the task's events in board terms (view run_events). */
export async function taskRunEvents(d: QueryDeps, taskId: string) {
  const { rows } = await d.db.execute<{
    id: number;
    ts: Date;
    agent: string;
    type: string;
    text: string;
    cost: string | null;
    payload: Record<string, unknown> | null;
  }>(sql`
    select id, ts, agent, type, text, cost, payload from run_events
    where task_id = ${taskId} and brand_id = ${d.brandId()}
    order by id limit 1000`);
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.ts).toISOString(),
    agent: r.agent,
    type: r.type,
    text: r.text,
    costUsd: r.cost == null ? null : Number(r.cost),
    payload: r.payload,
  }));
}
