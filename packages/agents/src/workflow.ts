import {
  InvalidTransitionError,
  PermanentError,
  type Actor,
  type AppConfig,
  type BudgetScope,
  type Logger,
  type ModelPricing,
  type TaskStatus,
} from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import {
  approveBudgetOverride,
  budgetStatus,
  createArtifactVersion,
  createRun,
  createTask,
  finalDecisions,
  getArtifact,
  latestArtifact,
  latestArtifacts,
  periodKeys,
  queuedRunsOfTask,
  recordDecision,
  resumeTask,
  transitionTask,
  withIdempotency,
  type Artifact,
  type BudgetContext,
  type LlmClient,
  type Run,
  type RunContext,
} from '@cms/engine';
import type { AgentContext } from './agents/context.js';
import { runCeo } from './agents/ceo.js';
import { runCopywriter, type RewriteRequest } from './agents/copywriter.js';
import { runCritic, type Verdict } from './agents/critic.js';
import { getBrand } from './brand.js';
import { invokeAgent } from './invocations.js';
import { agentById } from './registry.js';
import type { AgentResult } from './agents/context.js';
import type { OwnerChannel, PackageItemView } from './channel.js';
import { estimatePlan } from './estimate.js';
import { renderPackageMarkdown, writePackage, type ExportItem } from './export.js';
import { CeoPlan, type CopyItem, type Deliverable } from './schemas.js';

/** Critic may send a text back to the copywriter at most this many times. */
export const MAX_CRITIC_REVISIONS = 2;

const { tasks, runs } = schema;
const ORCHESTRATOR: Actor = { kind: 'agent', id: 'ceo' };
const SYSTEM: Actor = { kind: 'system', id: 'workflow' };

export type RunInput =
  | { kind: 'plan'; ownerComment?: string | null }
  | { kind: 'copy' }
  | {
      kind: 'rework';
      deliverableId: string;
      baseArtifactId: string;
      ownerComment: string | null;
      mode: 'revise' | 'regenerate';
    }
  | { kind: 'export' };

export interface CopyContent extends Record<string, unknown> {
  deliverable: Deliverable;
  item: CopyItem;
  critic: Verdict;
  criticRound: number;
  criticRejected: boolean;
  ownerComment: string | null;
}

export interface WorkflowDeps {
  db: Db;
  llm: LlmClient;
  channel: OwnerChannel;
  enqueue: (runId: string) => Promise<unknown>;
  config: AppConfig;
  pricing: ModelPricing;
  logger: Logger;
}

export interface DecisionResult {
  ok: boolean;
  /** Short text for the button press answer. */
  message: string;
}

type TaskRow = typeof tasks.$inferSelect;

export class Workflow {
  constructor(private readonly d: WorkflowDeps) {}

  private get budget(): BudgetContext {
    return { config: this.d.config.budget, timeZone: this.d.config.timezone };
  }

  // ---------------------------------------------------------------- owner actions

  async submitBrief(brandId: string, text: string, actor: Actor): Promise<{ taskId: string }> {
    const brief = text.trim();
    if (brief.length < 10)
      throw new PermanentError(
        'brief_too_short',
        'Бриф слишком короткий: опишите задачу подробнее',
      );
    const title = brief.split('\n')[0]!.slice(0, 80);
    const { id } = await createTask(this.d.db, {
      brandId,
      kind: 'content',
      title,
      brief: { text: brief },
      budgetUsd: this.d.config.budget.taskUsd,
      actor,
    });
    await this.startRun(brandId, id, 'ceo', `task:${id}:plan:v1`, { kind: 'plan' });
    return { taskId: id };
  }

  async decidePlan(
    taskId: string,
    action: 'approve' | 'change' | 'cancel',
    actor: Actor,
    comment?: string,
  ): Promise<DecisionResult> {
    const task = await this.task(taskId);
    if (task.status !== 'awaiting_plan_approval')
      return { ok: false, message: 'План уже не ждёт решения' };
    const plan = await latestArtifact(this.d.db, taskId, 'plan');
    if (!plan) return { ok: false, message: 'План не найден' };

    const decision =
      action === 'approve' ? 'approved' : action === 'change' ? 'changes_requested' : 'cancelled';
    const { recorded } = await recordDecision(this.d.db, {
      brandId: task.brandId,
      taskId,
      gate: 'plan',
      decision,
      actor,
      artifact: plan,
      comment: comment ?? null,
      idempotencyKey: `plan:${plan.id}`,
    });
    if (!recorded) return { ok: false, message: 'Решение по этой версии плана уже принято' };
    await this.resumeIfWaiting(task, actor);

    if (action === 'approve') {
      await transitionTask(this.d.db, {
        taskId,
        to: 'in_progress',
        actor,
        reason: 'plan approved',
        details: { planVersion: plan.version },
      });
      await this.startRun(
        task.brandId,
        taskId,
        'copywriter',
        `task:${taskId}:copy:plan-v${plan.version}`,
        { kind: 'copy' },
      );
      return { ok: true, message: 'План утверждён, команда начала работу' };
    }
    if (action === 'change') {
      await transitionTask(this.d.db, {
        taskId,
        to: 'planned',
        actor,
        reason: 'plan change requested',
        details: { comment },
      });
      await this.startRun(task.brandId, taskId, 'ceo', `task:${taskId}:plan:v${plan.version + 1}`, {
        kind: 'plan',
        ownerComment: comment ?? null,
      });
      return { ok: true, message: 'CEO переделывает план по вашему комментарию' };
    }
    await transitionTask(this.d.db, {
      taskId,
      to: 'cancelled',
      actor,
      reason: 'cancelled at plan gate',
    });
    return { ok: true, message: 'Задача отменена' };
  }

  /** Gate 2, per item: approve (optionally a variant), edit with a comment, or regenerate. */
  async decideArtifact(
    artifactId: string,
    action: 'approve' | 'revise' | 'regenerate',
    actor: Actor,
    opts: { variant?: number | null; comment?: string | null } = {},
  ): Promise<DecisionResult> {
    const artifact = await getArtifact(this.d.db, artifactId);
    if (!artifact || !artifact.slot.startsWith('copy:'))
      return { ok: false, message: 'Текст не найден' };
    const latest = await latestArtifact(this.d.db, artifact.taskId, artifact.slot);
    if (latest?.id !== artifact.id)
      return { ok: false, message: `Это устаревшая версия (актуальная — v${latest?.version})` };
    const task = await this.task(artifact.taskId);
    if (!['awaiting_final_approval', 'revision', 'in_review'].includes(task.status)) {
      return { ok: false, message: 'Пакет уже не ждёт решения' };
    }
    if (action === 'revise' && !opts.comment?.trim())
      return { ok: false, message: 'Нужен комментарий к правке' };

    const { recorded } = await recordDecision(this.d.db, {
      brandId: task.brandId,
      taskId: task.id,
      gate: 'final',
      decision:
        action === 'approve'
          ? 'approved'
          : action === 'revise'
            ? 'changes_requested'
            : 'regenerate',
      actor,
      artifact,
      comment: opts.comment ?? null,
      choice: action === 'approve' ? (opts.variant ?? null) : null,
      idempotencyKey: `final:${artifact.id}`,
    });
    if (!recorded) return { ok: false, message: `Решение по v${artifact.version} уже принято` };
    await this.resumeIfWaiting(task, actor);

    if (action === 'approve') {
      const done = await this.completeIfAllApproved(task.id, actor);
      return { ok: true, message: done ? 'Всё утверждено, собираю пакет' : 'Утверждено' };
    }
    if (task.status === 'awaiting_final_approval') {
      await transitionTask(this.d.db, {
        taskId: task.id,
        to: 'revision',
        actor,
        reason: `${action} ${artifact.slot}`,
        details: { artifactId },
      });
    }
    const content = artifact.content as CopyContent;
    await this.startRun(task.brandId, task.id, 'copywriter', `rework:${artifact.id}`, {
      kind: 'rework',
      deliverableId: content.deliverable.id,
      baseArtifactId: artifact.id,
      ownerComment: opts.comment ?? null,
      mode: action === 'revise' ? 'revise' : 'regenerate',
    });
    return { ok: true, message: action === 'revise' ? 'Отправил на правку' : 'Пишу заново' };
  }

  async approveAll(taskId: string, actor: Actor): Promise<DecisionResult> {
    const items = await latestArtifacts(this.d.db, taskId, 'copy:');
    const decided = await finalDecisions(this.d.db, taskId);
    let n = 0;
    for (const a of items) {
      if (decided.has(a.id)) continue;
      const r = await this.decideArtifact(a.id, 'approve', actor);
      if (r.ok) n++;
    }
    return { ok: n > 0, message: n > 0 ? `Утверждено: ${n}` : 'Нечего утверждать' };
  }

  async cancelTask(taskId: string, actor: Actor): Promise<DecisionResult> {
    const task = await this.task(taskId);
    try {
      await transitionTask(this.d.db, {
        taskId,
        to: 'cancelled',
        actor,
        reason: 'cancelled by owner',
      });
      return { ok: true, message: 'Задача отменена' };
    } catch (e) {
      if (e instanceof InvalidTransitionError)
        return { ok: false, message: `Нельзя отменить из статуса ${task.status}` };
      throw e;
    }
  }

  /**
   * Gate 2: reject the whole package. Human only, through transitionTask; recorded as a
   * decision. Can be undone with reopenPackage() as long as nothing was exported.
   */
  async rejectPackage(
    taskId: string,
    actor: Actor,
    comment?: string | null,
  ): Promise<DecisionResult> {
    const task = await this.task(taskId);
    if (task.status === 'rejected') return { ok: false, message: 'Пакет уже отклонён' };
    if (task.status !== 'awaiting_final_approval') {
      return { ok: false, message: 'Отклонить можно только пакет, который ждёт вашего решения' };
    }
    const { recorded } = await recordDecision(this.d.db, {
      brandId: task.brandId,
      taskId,
      gate: 'final',
      decision: 'rejected',
      actor,
      comment: comment ?? null,
      // One rejection per approval round: the task version changes on every status change.
      idempotencyKey: `reject:${taskId}:v${task.version}`,
    });
    if (!recorded) return { ok: false, message: 'Пакет уже отклонён' };
    await transitionTask(this.d.db, {
      taskId,
      to: 'rejected',
      actor,
      reason: 'package rejected',
      details: { comment: comment ?? null },
    });
    return { ok: true, message: 'Пакет отклонён. Вернуть можно, пока ничего не экспортировано.' };
  }

  /** Undo of a rejection: back to the approval gate. Impossible after export (state machine forbids it). */
  async reopenPackage(taskId: string, actor: Actor): Promise<DecisionResult> {
    const task = await this.task(taskId);
    if (task.status !== 'rejected') {
      return {
        ok: false,
        message:
          task.status === 'exported'
            ? 'Пакет уже экспортирован — вернуть нельзя'
            : 'Пакет не отклонён',
      };
    }
    await transitionTask(this.d.db, {
      taskId,
      to: 'awaiting_final_approval',
      actor,
      reason: 'rejection undone',
    });
    return { ok: true, message: 'Пакет снова ждёт вашего решения' };
  }

  /** Owner approved extra budget after a budget pause: raise the limit, resume, re-queue waiting runs. */
  async approveBudget(taskId: string, extraUsd: number, actor: Actor): Promise<DecisionResult> {
    const task = await this.task(taskId);
    if (!task.pausedAt || !task.pauseReason?.startsWith('budget:'))
      return { ok: false, message: 'Задача не на паузе по бюджету' };
    const scope = task.pauseReason.slice('budget:'.length) as BudgetScope;
    const { day, month } = periodKeys(new Date(), this.d.config.timezone);
    const periodKey = scope === 'task' ? taskId : scope === 'day' ? day : month;
    await approveBudgetOverride(this.d.db, {
      brandId: task.brandId,
      scope,
      periodKey,
      extraUsd,
      actor,
      taskId,
    });
    await resumeTask(this.d.db, taskId, actor);
    for (const run of await queuedRunsOfTask(this.d.db, taskId)) await this.d.enqueue(run.id);
    return { ok: true, message: `Добавлено $${extraUsd} (${scope}), продолжаю` };
  }

  // ---------------------------------------------------------------- queue handler

  /** Dispatches a run from the queue to the right step. */
  readonly handleRun = async (run: Run, rc: RunContext): Promise<Record<string, unknown>> => {
    const input = run.input as RunInput;
    const task = await this.task(run.taskId);
    if (task.status === 'cancelled') return { skipped: 'task cancelled' };
    const ctx = await this.agentContext(run, task, rc.signal);
    switch (input.kind) {
      case 'plan':
        return this.planStep(run, task, ctx, input.ownerComment ?? null);
      case 'copy':
        return this.copyStep(run, task, ctx);
      case 'rework':
        return this.reworkStep(run, task, ctx, input);
      case 'export':
        return this.exportStep(run, task);
    }
  };

  private async planStep(run: Run, task: TaskRow, ctx: AgentContext, ownerComment: string | null) {
    const previous = await latestArtifact(this.d.db, task.id, 'plan');
    const result = await this.invoke('ceo', run, task, () =>
      runCeo(ctx, {
        brief: briefText(task),
        ...(previous ? { previousPlan: CeoPlan.parse(previous.content) } : {}),
        ...(ownerComment ? { ownerComment } : {}),
      }),
    );
    const artifact = await createArtifactVersion(this.d.db, `${run.id}:plan`, {
      brandId: task.brandId,
      taskId: task.id,
      runId: run.id,
      slot: 'plan',
      kind: 'plan',
      content: result.output,
      agent: 'ceo',
      promptVersion: result.promptVersion,
      model: result.model,
    });
    await this.moveTo(task.id, 'planned');
    await this.moveTo(task.id, 'awaiting_plan_approval');

    const estimate = estimatePlan(result.output, this.d.pricing, this.d.config.llm.models);
    const spend = await this.spend(task);
    await this.once(`${run.id}:send-plan`, () =>
      this.d.channel.sendPlan({
        taskId: task.id,
        title: task.title,
        planArtifactId: artifact.id,
        version: artifact.version,
        plan: result.output,
        estimate,
        spentUsd: spend.spentUsd,
        taskBudgetUsd: spend.limitUsd,
      }),
    );
    return { planArtifactId: artifact.id, version: artifact.version, costUsd: result.costUsd };
  }

  private async copyStep(run: Run, task: TaskRow, ctx: AgentContext) {
    const plan = await this.plan(task.id);
    const created = await this.writeAndReview(run, task, ctx, plan, plan.deliverables, {});
    await this.finishReview(run, task, created, false);
    return { artifacts: created.map((a) => a.id) };
  }

  private async reworkStep(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    input: Extract<RunInput, { kind: 'rework' }>,
  ) {
    const plan = await this.plan(task.id);
    const base = await getArtifact(this.d.db, input.baseArtifactId);
    const deliverable = plan.deliverables.find((d) => d.id === input.deliverableId);
    if (!base || !deliverable)
      throw new PermanentError('rework_target_missing', 'Rework target not found');
    const content = base.content as CopyContent;
    const created = await this.writeAndReview(run, task, ctx, plan, [deliverable], {
      [deliverable.id]: {
        previous: content.item,
        ownerComment: input.ownerComment,
        mode: input.mode,
      },
    });
    await this.finishReview(run, task, created, true);
    return { artifacts: created.map((a) => a.id) };
  }

  /**
   * Copywriter -> Critic loop. Every draft becomes an artifact version together with the
   * Critic verdict on it. Failed items go back to the copywriter with the Critic's issues
   * (and the owner's comment, if any) at most MAX_CRITIC_REVISIONS times.
   */
  private async writeAndReview(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    plan: CeoPlan,
    deliverables: Deliverable[],
    initial: Record<string, RewriteRequest>,
  ): Promise<Artifact[]> {
    const finals: Artifact[] = [];
    let pending = deliverables;
    let rewrites = initial;
    const ownerComments = Object.fromEntries(
      Object.entries(initial).map(([k, v]) => [k, v.ownerComment ?? null]),
    );

    for (let round = 0; round <= MAX_CRITIC_REVISIONS && pending.length > 0; round++) {
      if (round > 0) await this.moveTo(task.id, 'revision');
      const copy = await this.invoke('copywriter', run, task, () =>
        runCopywriter(ctx, {
          brief: briefText(task),
          planSummary: plan.summary,
          deliverables: pending,
          rewrites,
          step: `r${round}`,
        }),
      );
      await this.moveTo(task.id, 'in_review');
      const review = await this.invoke('critic', run, task, () =>
        runCritic(ctx, {
          brief: briefText(task),
          deliverables: pending,
          items: copy.output.items,
          step: `r${round}`,
        }),
      );

      const failed: Deliverable[] = [];
      const nextRewrites: Record<string, RewriteRequest> = {};
      for (const d of pending) {
        const item = copy.output.items.find((i) => i.deliverableId === d.id)!;
        const verdict = review.output.find((v) => v.deliverableId === d.id)!;
        const last = round === MAX_CRITIC_REVISIONS;
        const artifact = await createArtifactVersion(this.d.db, `${run.id}:r${round}:${d.id}`, {
          brandId: task.brandId,
          taskId: task.id,
          runId: run.id,
          slot: `copy:${d.id}`,
          kind: 'copy',
          content: {
            deliverable: d,
            item,
            critic: verdict,
            criticRound: round + 1,
            criticRejected: !verdict.passed && last,
            ownerComment: ownerComments[d.id] ?? null,
          } satisfies CopyContent,
          agent: 'copywriter',
          promptVersion: `${copy.promptVersion}+${review.promptVersion}`,
          model: copy.model,
        });
        if (verdict.passed || last) finals.push(artifact);
        else {
          failed.push(d);
          nextRewrites[d.id] = {
            previous: item,
            criticIssues: verdict.issues,
            ownerComment: ownerComments[d.id] ?? null,
            mode: 'revise',
          };
        }
      }
      pending = failed;
      rewrites = nextRewrites;
    }
    // Show items to the owner in plan order, not in the order the Critic passed them.
    const order = deliverables.map((d) => `copy:${d.id}`);
    return finals.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  }

  /** Moves the task to gate 2 (unless another rework is still running) and shows the items to the owner. */
  private async finishReview(run: Run, task: TaskRow, created: Artifact[], isUpdate: boolean) {
    const others = await this.d.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        sql`${runs.taskId} = ${task.id} and ${runs.id} <> ${run.id} and ${runs.agent} = 'copywriter' and ${runs.status} in ('queued', 'running')`,
      );
    if (others.length === 0) await this.moveTo(task.id, 'awaiting_final_approval');

    const all = await latestArtifacts(this.d.db, task.id, 'copy:');
    const decided = await finalDecisions(this.d.db, task.id);
    const pendingCount = all.filter((a) => decided.get(a.id)?.decision !== 'approved').length;
    const spend = await this.spend(task);
    await this.once(`${run.id}:send-package`, () =>
      this.d.channel.sendPackage({
        taskId: task.id,
        title: task.title,
        items: created.map(toItemView),
        pendingCount,
        totalCount: all.length,
        spentUsd: spend.spentUsd,
        taskBudgetUsd: spend.limitUsd,
        isUpdate,
      }),
    );
  }

  private async completeIfAllApproved(taskId: string, actor: Actor): Promise<boolean> {
    const task = await this.task(taskId);
    if (task.status !== 'awaiting_final_approval') return false;
    const all = await latestArtifacts(this.d.db, taskId, 'copy:');
    const decided = await finalDecisions(this.d.db, taskId);
    if (all.length === 0 || !all.every((a) => decided.get(a.id)?.decision === 'approved'))
      return false;
    const r = await transitionTask(this.d.db, {
      taskId,
      to: 'approved',
      actor,
      reason: 'all items approved',
      details: { artifacts: all.map((a) => `${a.slot}@v${a.version}`) },
    });
    if (r.changed) {
      await this.startRun(
        task.brandId,
        taskId,
        'exporter',
        `task:${taskId}:export:${all
          .map((a) => a.id)
          .sort()
          .join(',')
          .slice(0, 300)}`,
        { kind: 'export' },
      );
    }
    return true;
  }

  private async exportStep(run: Run, task: TaskRow) {
    const all = await latestArtifacts(this.d.db, task.id, 'copy:');
    const decided = await finalDecisions(this.d.db, task.id);
    const items: ExportItem[] = all
      .filter((a) => decided.get(a.id)?.decision === 'approved')
      .map((a) => {
        const c = a.content as CopyContent;
        return {
          artifactId: a.id,
          version: a.version,
          promptVersion: a.promptVersion,
          model: a.model,
          deliverable: c.deliverable,
          item: c.item,
          critic: c.critic,
          criticRejected: c.criticRejected,
          choice: decided.get(a.id)?.choice ?? null,
        };
      });
    const spend = await this.spend(task);
    const { result } = await withIdempotency(this.d.db, `${run.id}:write-package`, async () => {
      const r = await writePackage(
        this.d.config.exportDir,
        { id: task.id, title: task.title, brief: briefText(task) },
        items,
        spend.spentUsd,
      );
      return { dir: r.dir };
    });
    await this.moveTo(task.id, 'exported', SYSTEM);
    await this.once(`${run.id}:send-export`, async () => {
      await this.d.channel.sendExport({
        taskId: task.id,
        title: task.title,
        dir: result.dir,
        files: [
          {
            name: 'package.md',
            content: Buffer.from(
              renderPackageMarkdown(task.title, briefText(task), items, spend.spentUsd),
              'utf8',
            ),
          },
        ],
        spentUsd: spend.spentUsd,
      });
    });
    return { dir: result.dir, items: items.length };
  }

  // ---------------------------------------------------------------- helpers

  private async startRun(
    brandId: string,
    taskId: string,
    agent: string,
    key: string,
    input: RunInput,
  ) {
    const { run } = await createRun(this.d.db, {
      brandId,
      taskId,
      agent,
      idempotencyKey: key,
      input,
    });
    if (run.status === 'queued') await this.d.enqueue(run.id);
    return run;
  }

  /** Every agent call goes through the registry + invocation log. */
  private invoke<T>(agentId: string, run: Run, task: TaskRow, fn: () => Promise<AgentResult<T>>) {
    const def = agentById(agentId);
    if (!def) throw new PermanentError('unknown_agent', `Agent ${agentId} is not in the registry`);
    return invokeAgent(
      this.d.db,
      def,
      {
        brandId: task.brandId,
        taskId: task.id,
        runId: run.id,
        model: this.d.config.llm.models[def.modelRole],
      },
      fn,
    );
  }

  private async agentContext(run: Run, task: TaskRow, signal: AbortSignal): Promise<AgentContext> {
    return {
      llm: this.d.llm,
      models: this.d.config.llm.models,
      brand: await getBrand(this.d.db, task.brandId),
      taskId: task.id,
      runId: run.id,
      callKey: run.id,
      signal,
    };
  }

  private async task(id: string): Promise<TaskRow> {
    const [t] = await this.d.db
      .select()
      .from(tasks)
      .where(sql`${tasks.id} = ${id}`);
    if (!t) throw new PermanentError('task_not_found', `Task ${id} not found`);
    return t;
  }

  private async plan(taskId: string): Promise<CeoPlan> {
    const a = await latestArtifact(this.d.db, taskId, 'plan');
    if (!a) throw new PermanentError('plan_missing', 'Task has no plan');
    return CeoPlan.parse(a.content);
  }

  private async spend(task: TaskRow) {
    const s = await budgetStatus(this.d.db, this.budget, task.brandId, task.id);
    return s.find((x) => x.scope === 'task')!;
  }

  /** Idempotent status move used by run steps (safe when a run is retried halfway). */
  private async moveTo(taskId: string, to: TaskStatus, actor: Actor = ORCHESTRATOR) {
    await transitionTask(this.d.db, { taskId, to, actor });
  }

  private async resumeIfWaiting(task: TaskRow, actor: Actor) {
    if (task.pausedAt && task.pauseReason === 'approval_timeout')
      await resumeTask(this.d.db, task.id, actor);
  }

  private async once(key: string, fn: () => Promise<void>) {
    await withIdempotency(this.d.db, key, async () => {
      await fn();
      return true;
    });
  }
}

export function briefText(task: Pick<TaskRow, 'brief'>): string {
  const text = (task.brief as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export function toItemView(a: Artifact): PackageItemView {
  const c = a.content as CopyContent;
  return {
    artifactId: a.id,
    version: a.version,
    deliverable: c.deliverable,
    item: c.item,
    critic: c.critic,
    criticRound: c.criticRound,
    criticRejected: c.criticRejected,
    ownerComment: c.ownerComment,
  };
}
