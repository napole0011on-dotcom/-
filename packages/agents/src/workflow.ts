import { createHash } from 'node:crypto';
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
import type { ObjectStorage } from '@cms/providers';
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
import { AgentControls, makeRunGate } from './controls.js';
import type { AgentResult } from './agents/context.js';
import type { NodeItemView, OwnerChannel, PackageItemView } from './channel.js';
import { estimatePlan } from './estimate.js';
import { emitEvent } from './events.js';
import {
  renderPackageMarkdown,
  writePackage,
  type ExportItem,
  type ExportNodeItem,
} from './export.js';
import { COPYWRITER, DEFAULT_PIPELINE, type Pipeline, type PipelineStep } from './graph.js';
import {
  nodeSlot,
  nodeSlotPrefix,
  renderGeneric,
  type NodeContent,
  type NodeExecutor,
  type NodeInput,
  type UpstreamResult,
} from './nodes.js';
import { constructorExecutor } from './constructor.js';
import { constructorSpecOf, resolveAgent } from './agent-registry.js';
import { CeoPlan, type CopyItem, type Deliverable } from './schemas.js';
import { currentPipeline, loadWorkspace } from './workspace.js';

/** Critic may send a text back to the copywriter at most this many times. */
export const MAX_CRITIC_REVISIONS = 2;

const { tasks, runs } = schema;
const ORCHESTRATOR: Actor = { kind: 'agent', id: 'ceo' };
const SYSTEM: Actor = { kind: 'system', id: 'workflow' };

export type RunInput =
  | { kind: 'plan'; ownerComment?: string | null }
  | { kind: 'copy'; inputSig?: string }
  | {
      kind: 'node';
      agent: string;
      inputSig: string;
      /** The Critic reviews this step (then it also waits while the Critic is paused). */
      reviewed?: boolean;
      rework?: {
        baseArtifactId: string;
        ownerComment: string | null;
        mode: 'revise' | 'regenerate';
      };
    }
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
  /** Hash of the upstream results the texts were written from ("root" = only the plan). */
  inputSig?: string;
}

export interface WorkflowDeps {
  db: Db;
  llm: LlmClient;
  channel: OwnerChannel;
  enqueue: (runId: string) => Promise<unknown>;
  config: AppConfig;
  pricing: ModelPricing;
  logger: Logger;
  /** Executors for graph steps other than the copywriter, by agent id (constructor, code, tool). */
  executors?: Record<string, NodeExecutor>;
  /** Object storage with files of steps (images); copied into the export folder. */
  storage?: ObjectStorage;
}

export interface DecisionResult {
  ok: boolean;
  /** Short text for the button press answer. */
  message: string;
}

type TaskRow = typeof tasks.$inferSelect;

export class Workflow {
  /** Owner's agent controls (pause, model, prompts); the panel uses the same instance. */
  readonly controls: AgentControls;
  /** Queue gate: a run waits while one of its agents is paused/disabled or everything is stopped. */
  readonly gate: (run: Run) => Promise<string | null>;

  constructor(private readonly d: WorkflowDeps) {
    this.controls = new AgentControls({
      db: d.db,
      config: d.config,
      pricing: d.pricing,
      enqueue: d.enqueue,
      logger: d.logger,
    });
    this.gate = makeRunGate(d.db);
  }

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
      await emitEvent(this.d.db, {
        brandId: task.brandId,
        agent: 'me',
        taskId,
        kind: 'decision',
        text: `Вы · план v${plan.version} утверждён`,
      });
      // The steps and their order come from the plan's snapshot of the board, not the live board.
      await this.advance(taskId, null);
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
    if (!artifact || !(artifact.slot.startsWith('copy:') || artifact.slot.startsWith('node:')))
      return { ok: false, message: 'Результат не найден' };
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
    if (artifact.slot.startsWith('node:')) {
      const nc = artifact.content as NodeContent;
      await this.startRun(task.brandId, task.id, nc.agent, `rework:${artifact.id}`, {
        kind: 'node',
        agent: nc.agent,
        inputSig: nc.inputSig,
        reviewed: (await this.pipelineOf(task.id)).steps.find((x) => x.agent === nc.agent)
          ?.reviewed,
        rework: {
          baseArtifactId: artifact.id,
          ownerComment: opts.comment ?? null,
          mode: action === 'revise' ? 'revise' : 'regenerate',
        },
      });
      return { ok: true, message: action === 'revise' ? 'Отправил на правку' : 'Делаю заново' };
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
    const items = await this.packageArtifacts(taskId);
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
        return this.copyStep(run, task, ctx, input);
      case 'rework':
        return this.reworkStep(run, task, ctx, input);
      case 'node':
        return this.nodeStep(run, task, ctx, input);
      case 'export':
        return this.exportStep(run, task);
    }
  };

  private async planStep(run: Run, task: TaskRow, ctx: AgentContext, ownerComment: string | null) {
    const previous = await latestArtifact(this.d.db, task.id, 'plan');
    // The plan carries a snapshot of the board: approving the plan freezes the steps for this task.
    const pipeline = await currentPipeline(this.d.db, task.brandId);
    const ws = await loadWorkspace(this.d.db, task.brandId);
    const team = pipeline.steps.map((s) => {
      const n = ws.nodes.find((x) => x.id === s.agent);
      return { name: s.name, role: n?.role ?? '' };
    });
    const result = await this.invoke('ceo', run, task, ctx, () =>
      runCeo(ctx, {
        brief: briefText(task),
        team,
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
      content: { ...result.output, pipeline },
      agent: 'ceo',
      promptVersion: result.promptVersion,
      model: result.model,
    });
    await this.moveTo(task.id, 'planned');
    await this.moveTo(task.id, 'awaiting_plan_approval');

    const estimate = estimatePlan(result.output, this.d.pricing, ctx.models);
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
        pipeline,
      }),
    );
    await emitEvent(this.d.db, {
      brandId: task.brandId,
      agent: 'ceo',
      taskId: task.id,
      runId: run.id,
      kind: 'plan_ready',
      text: `CEO · план v${artifact.version} готов, ждёт вас`,
      costUsd: result.costUsd,
    });
    return { planArtifactId: artifact.id, version: artifact.version, costUsd: result.costUsd };
  }

  private async copyStep(run: Run, task: TaskRow, ctx: AgentContext, input: { inputSig?: string }) {
    const plan = await this.plan(task.id);
    const step = (await this.pipelineOf(task.id)).steps.find((s) => s.agent === COPYWRITER);
    const upstream = step ? await this.upstreamOf(task.id, step) : [];
    const created = await this.writeAndReview(
      run,
      task,
      ctx,
      plan,
      plan.deliverables,
      {},
      {
        inputSig: input.inputSig ?? 'root',
        upstream,
      },
    );
    await this.advance(task.id, run);
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
    const step = (await this.pipelineOf(task.id)).steps.find((s) => s.agent === COPYWRITER);
    const created = await this.writeAndReview(
      run,
      task,
      ctx,
      plan,
      [deliverable],
      {
        [deliverable.id]: {
          previous: content.item,
          ownerComment: input.ownerComment,
          mode: input.mode,
        },
      },
      {
        inputSig: content.inputSig ?? 'root',
        upstream: step ? await this.upstreamOf(task.id, step) : [],
      },
    );
    await this.advance(task.id, run);
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
    from: { inputSig: string; upstream: UpstreamResult[] },
  ): Promise<Artifact[]> {
    const finals: Artifact[] = [];
    let pending = deliverables;
    let rewrites = initial;
    const ownerComments = Object.fromEntries(
      Object.entries(initial).map(([k, v]) => [k, v.ownerComment ?? null]),
    );

    for (let round = 0; round <= MAX_CRITIC_REVISIONS && pending.length > 0; round++) {
      if (round > 0) await this.moveTo(task.id, 'revision');
      const copy = await this.invoke('copywriter', run, task, ctx, () =>
        runCopywriter(ctx, {
          brief: briefText(task),
          planSummary: plan.summary,
          deliverables: pending,
          rewrites,
          upstream: from.upstream,
          step: `r${round}`,
        }),
      );
      await this.moveTo(task.id, 'in_review');
      const review = await this.invoke('critic', run, task, ctx, () =>
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
            inputSig: from.inputSig,
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
      const passedN = pending.length - failed.length;
      await emitEvent(this.d.db, {
        brandId: task.brandId,
        agent: 'critic',
        taskId: task.id,
        runId: run.id,
        kind: 'verdict',
        text:
          failed.length === 0
            ? `Critic · вердикт: принято (${passedN})`
            : `Critic · вердикт: доработать ${failed.length}${passedN ? `, принято ${passedN}` : ''}`,
        costUsd: review.costUsd,
      });
      pending = failed;
      rewrites = nextRewrites;
    }
    // Show items to the owner in plan order, not in the order the Critic passed them.
    const order = deliverables.map((d) => `copy:${d.id}`);
    return finals.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  }

  // ---------------------------------------------------------------- graph execution

  /** Steps of this task: the board snapshot stored in the plan (old plans: copywriter only). */
  private async pipelineOf(taskId: string): Promise<Pipeline> {
    const a = await latestArtifact(this.d.db, taskId, 'plan');
    const p = (a?.content as { pipeline?: Pipeline } | undefined)?.pipeline;
    return p?.steps?.length ? p : DEFAULT_PIPELINE;
  }

  private async nodeArtifacts(taskId: string): Promise<Artifact[]> {
    return latestArtifacts(this.d.db, taskId, 'node:');
  }

  /** Everything the owner decides on at gate 2: texts and results of the other steps. */
  private async packageArtifacts(taskId: string): Promise<Artifact[]> {
    return [
      ...(await latestArtifacts(this.d.db, taskId, 'copy:')),
      ...(await this.nodeArtifacts(taskId)),
    ];
  }

  private async stepArtifacts(taskId: string, agent: string): Promise<Artifact[]> {
    return agent === COPYWRITER
      ? latestArtifacts(this.d.db, taskId, 'copy:')
      : latestArtifacts(this.d.db, taskId, nodeSlotPrefix(agent));
  }

  private static sigOf(arts: Artifact[]): string {
    if (arts.length === 0) return 'root';
    return createHash('sha256')
      .update(
        arts
          .map((a) => a.id)
          .sort()
          .join(','),
      )
      .digest('hex')
      .slice(0, 16);
  }

  /** Results of the steps this step waits for, as data for its prompt. */
  private async upstreamOf(taskId: string, step: PipelineStep): Promise<UpstreamResult[]> {
    const out: UpstreamResult[] = [];
    for (const dep of step.after) {
      const arts = await this.stepArtifacts(taskId, dep);
      if (dep === COPYWRITER) {
        out.push({
          agent: dep,
          name: 'Копирайтер',
          items: arts.map((a) => {
            const c = a.content as CopyContent;
            return {
              deliverable: c.deliverable,
              variants: c.item.variants,
              critic: c.critic.summary,
            };
          }),
        });
      } else {
        const c = arts[0]?.content as NodeContent | undefined;
        out.push({
          agent: dep,
          name: c?.name ?? dep,
          items: arts.map((a) => (a.content as NodeContent).output),
        });
      }
    }
    return out;
  }

  /** Which step each queued/running run of the task belongs to (except the current one). */
  private async activeSteps(taskId: string, exceptRunId: string | null): Promise<Set<string>> {
    const rows = await this.d.db
      .select({ id: runs.id, input: runs.input })
      .from(runs)
      .where(sql`${runs.taskId} = ${taskId} and ${runs.status} in ('queued', 'running')`);
    const out = new Set<string>();
    for (const r of rows) {
      if (r.id === exceptRunId) continue;
      const i = r.input as RunInput;
      if (i.kind === 'copy' || i.kind === 'rework') out.add(COPYWRITER);
      else if (i.kind === 'node') out.add(i.agent);
    }
    return out;
  }

  /**
   * Drives the graph after the plan is approved and after every step: starts each step whose
   * upstream steps are done (fresh: produced from the current upstream results), re-runs a step
   * when its upstream changed (e.g. a text was revised), shows finished results to the owner and
   * moves the task to gate 2 when nothing is left to run. Safe to call repeatedly.
   */
  private async advance(taskId: string, current: Run | null): Promise<void> {
    const task = await this.task(taskId);
    if (!['in_progress', 'in_review', 'revision', 'awaiting_final_approval'].includes(task.status))
      return;
    const pipe = await this.pipelineOf(taskId);
    const planArt = await latestArtifact(this.d.db, taskId, 'plan');
    const active = await this.activeSteps(taskId, current?.id ?? null);
    const state = new Map<string, { fresh: boolean; arts: Artifact[] }>();
    for (const step of pipe.steps) {
      const ready = step.after.every((d) => state.get(d)?.fresh && !active.has(d));
      if (!ready) {
        state.set(step.agent, { fresh: false, arts: [] });
        continue;
      }
      const sig = Workflow.sigOf(step.after.flatMap((d) => state.get(d)!.arts));
      const arts = await this.stepArtifacts(taskId, step.agent);
      const fresh =
        arts.length > 0 &&
        arts.every((a) => ((a.content as { inputSig?: string }).inputSig ?? 'root') === sig);
      state.set(step.agent, { fresh, arts });
      if (fresh || active.has(step.agent)) continue;
      if (step.agent === COPYWRITER) {
        await this.startRun(
          task.brandId,
          taskId,
          COPYWRITER,
          `task:${taskId}:copy:plan-v${planArt?.version ?? 1}${sig === 'root' ? '' : `:${sig}`}`,
          { kind: 'copy', inputSig: sig },
        );
      } else {
        await this.startRun(
          task.brandId,
          taskId,
          step.agent,
          `task:${taskId}:node:${step.agent}:${sig}`,
          {
            kind: 'node',
            agent: step.agent,
            inputSig: sig,
            reviewed: step.reviewed,
          },
        );
      }
      active.add(step.agent);
    }

    const settled = (agent: string) => state.get(agent)?.fresh === true && !active.has(agent);
    const downstream = (agent: string): string[] => {
      const direct = pipe.steps.filter((s) => s.after.includes(agent)).map((s) => s.agent);
      return [...direct, ...direct.flatMap(downstream)];
    };
    // A step's results are shown once nothing after it still needs to run on them.
    const showable = pipe.steps
      .map((s) => s.agent)
      .filter((a) => settled(a) && downstream(a).every(settled));
    const allSettled = pipe.steps.every((s) => settled(s.agent));
    if (allSettled) await this.toGate(task);
    await this.sendPackageItems(
      task,
      showable.flatMap((a) => state.get(a)!.arts),
    );
  }

  /** in_progress / revision -> in_review -> awaiting_final_approval (idempotent). */
  private async toGate(task: TaskRow) {
    const fresh = await this.task(task.id);
    if (fresh.status === 'awaiting_final_approval') return;
    if (fresh.status === 'in_progress' || fresh.status === 'revision')
      await this.moveTo(task.id, 'in_review');
    await this.moveTo(task.id, 'awaiting_final_approval');
    await emitEvent(this.d.db, {
      brandId: task.brandId,
      agent: 'me',
      taskId: task.id,
      kind: 'waiting_owner',
      text: `Пакет «${task.title}» ждёт вашего решения`,
    });
  }

  /** Sends the owner the results not shown yet (each artifact exactly once). */
  private async sendPackageItems(task: TaskRow, candidates: Artifact[]) {
    const decided = await finalDecisions(this.d.db, task.id);
    const keyOf = (id: string) => `pkg-item:${task.id}:${id}`;
    const fresh = candidates.filter((a) => !decided.has(a.id));
    if (fresh.length === 0) return;
    const keys = fresh.map((a) => keyOf(a.id));
    const sentRows = await this.d.db
      .select({ key: schema.idempotencyKeys.key })
      .from(schema.idempotencyKeys)
      .where(
        sql`${schema.idempotencyKeys.key} in ${keys} and ${schema.idempotencyKeys.status} = 'completed'`,
      );
    const sent = new Set(sentRows.map((r) => r.key));
    const unsent = fresh.filter((a) => !sent.has(keyOf(a.id)));
    if (unsent.length === 0) return;
    const [{ n: before } = { n: 0 }] = await this.d.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.idempotencyKeys)
      .where(sql`${schema.idempotencyKeys.key} like ${`pkg-item:${task.id}:%`}`);
    const all = await this.packageArtifacts(task.id);
    const pendingCount = all.filter((a) => decided.get(a.id)?.decision !== 'approved').length;
    const spend = await this.spend(task);
    const ids = unsent.map((a) => a.id).sort();
    const order = (await this.plan(task.id)).deliverables.map((d) => `copy:${d.id}`);
    const copies = unsent
      .filter((a) => a.slot.startsWith('copy:'))
      .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    await this.once(
      `pkg:${task.id}:${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 24)}`,
      () =>
        this.d.channel.sendPackage({
          taskId: task.id,
          title: task.title,
          items: copies.map(toItemView),
          nodeItems: unsent.filter((a) => a.slot.startsWith('node:')).map(toNodeView),
          pendingCount,
          totalCount: all.length,
          spentUsd: spend.spentUsd,
          taskBudgetUsd: spend.limitUsd,
          isUpdate: before > 0,
        }),
    );
    for (const a of unsent) await this.once(keyOf(a.id), () => Promise.resolve());
  }

  /** A graph step other than the copywriter (with an optional Critic review loop). */
  private async nodeStep(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    input: Extract<RunInput, { kind: 'node' }>,
  ) {
    const pipe = await this.pipelineOf(task.id);
    const step = pipe.steps.find((s) => s.agent === input.agent);
    if (!step) throw new PermanentError('step_missing', `Step ${input.agent} is not in the plan`);
    const exec =
      this.d.executors?.[input.agent] ?? (await this.registryExecutor(task, input.agent));
    if (!exec)
      throw new PermanentError('no_executor', `Агент ${step.name} пока не умеет выполнять шаги`);
    const plan = await this.plan(task.id);
    const base = input.rework ? await getArtifact(this.d.db, input.rework.baseArtifactId) : null;
    const baseContent = base?.content as NodeContent | undefined;
    let nodeInput: NodeInput = {
      brief: briefText(task),
      plan,
      upstream: await this.upstreamOf(task.id, step),
      previous: input.rework?.mode === 'revise' ? (baseContent?.output ?? null) : null,
      ownerComment: input.rework?.ownerComment ?? null,
      criticIssues: [],
      mode: input.rework?.mode ?? 'first',
      step: 'r0',
    };
    let artifact: Artifact | null = null;
    for (let round = 0; round <= MAX_CRITIC_REVISIONS; round++) {
      nodeInput = { ...nodeInput, step: `r${round}` };
      const res = await this.invoke(input.agent, run, task, ctx, () => exec.run(ctx, nodeInput));
      const review =
        step.reviewed && exec.review
          ? await this.invoke('critic', run, task, ctx, () =>
              exec.review!(ctx, nodeInput, res.output),
            )
          : null;
      const last = round === MAX_CRITIC_REVISIONS;
      const verdict = review?.output ?? null;
      artifact = await createArtifactVersion(this.d.db, `${run.id}:r${round}:${input.agent}`, {
        brandId: task.brandId,
        taskId: task.id,
        runId: run.id,
        slot: nodeSlot(input.agent),
        kind: 'node',
        content: {
          agent: input.agent,
          name: step.name,
          output: res.output,
          render: (() => {
            try {
              return exec.render(res.output);
            } catch {
              return renderGeneric(res.output, step.name);
            }
          })(),
          inputSig: input.inputSig,
          files: exec.files?.(res.output) ?? [],
          critic: verdict,
          criticRound: round + 1,
          criticRejected: !!verdict && !verdict.passed && last,
          ownerComment: nodeInput.ownerComment,
        } satisfies NodeContent,
        agent: input.agent,
        promptVersion: review ? `${res.promptVersion}+${review.promptVersion}` : res.promptVersion,
        model: res.model,
      });
      if (verdict) {
        await emitEvent(this.d.db, {
          brandId: task.brandId,
          agent: 'critic',
          taskId: task.id,
          runId: run.id,
          kind: 'verdict',
          text: `Critic · ${step.name}: ${verdict.passed ? 'принято' : 'доработать'}`,
          costUsd: review!.costUsd,
        });
      }
      if (!verdict || verdict.passed || last) break;
      nodeInput = {
        ...nodeInput,
        previous: res.output,
        criticIssues: verdict.issues,
        mode: 'revise',
      };
    }
    await this.advance(task.id, run);
    return { artifact: artifact!.id };
  }

  private async completeIfAllApproved(taskId: string, actor: Actor): Promise<boolean> {
    const task = await this.task(taskId);
    if (task.status !== 'awaiting_final_approval') return false;
    const all = await this.packageArtifacts(taskId);
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
    const nodes: ExportNodeItem[] = (await this.nodeArtifacts(task.id))
      .filter((a) => decided.get(a.id)?.decision === 'approved')
      .map((a) => {
        const c = a.content as NodeContent;
        return {
          artifactId: a.id,
          version: a.version,
          agent: c.agent,
          agentName: c.name,
          promptVersion: a.promptVersion,
          model: a.model,
          render: c.render,
          output: c.output,
          files: c.files ?? [],
        };
      });
    const spend = await this.spend(task);
    const { result } = await withIdempotency(this.d.db, `${run.id}:write-package`, async () => {
      const r = await writePackage(
        this.d.config.exportDir,
        { id: task.id, title: task.title, brief: briefText(task) },
        items,
        spend.spentUsd,
        new Date(),
        nodes,
        this.d.storage ? (key) => this.d.storage!.get(key) : undefined,
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
              renderPackageMarkdown(task.title, briefText(task), items, spend.spentUsd, nodes),
              'utf8',
            ),
          },
        ],
        spentUsd: spend.spentUsd,
      });
    });
    await emitEvent(this.d.db, {
      brandId: task.brandId,
      agent: 'me',
      taskId: task.id,
      runId: run.id,
      kind: 'exported',
      text: `Пакет экспортирован: ${items.length + nodes.length} результатов`,
    });
    return { dir: result.dir, items: items.length + nodes.length };
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

  /** Constructor agents run from their registry row (fields, criteria) and prompt. */
  private async registryExecutor(task: TaskRow, agentId: string): Promise<NodeExecutor | null> {
    const ref = await resolveAgent(this.d.db, task.brandId, agentId);
    if (!ref || ref.kind !== 'constructor') return null;
    const { spec } = constructorSpecOf(ref);
    if (!spec) return null;
    return constructorExecutor({ id: ref.id, name: ref.name, role: ref.role, spec });
  }

  /** Every agent call goes through the registry + invocation log (code and board agents). */
  private async invoke<T>(
    agentId: string,
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    fn: () => Promise<AgentResult<T>>,
  ) {
    const code = agentById(agentId);
    const node = code
      ? null
      : (await loadWorkspace(this.d.db, task.brandId)).nodes.find((n) => n.id === agentId);
    if (!code && !node)
      throw new PermanentError('unknown_agent', `Agent ${agentId} is not in the registry`);
    const role = (code?.modelRole ?? node?.modelRole ?? null) as
      keyof AgentContext['models'] | null;
    const prompt = ctx.prompts[code?.prompt ?? agentId];
    return invokeAgent(
      this.d.db,
      { id: agentId, name: code?.name ?? node!.name },
      {
        brandId: task.brandId,
        taskId: task.id,
        runId: run.id,
        model: ctx.agentModels[agentId] ?? (role ? ctx.models[role] : 'tool'),
        promptVersion: prompt?.version ?? `${agentId}@code`,
      },
      fn,
    );
  }

  private async agentContext(run: Run, task: TaskRow, signal: AbortSignal): Promise<AgentContext> {
    return {
      llm: this.d.llm,
      models: await this.controls.effectiveModels(task.brandId),
      prompts: await this.controls.prompts(task.brandId),
      agentModels: await this.controls.agentModels(task.brandId),
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

export function toNodeView(a: Artifact): NodeItemView {
  const c = a.content as NodeContent;
  return {
    artifactId: a.id,
    version: a.version,
    agent: c.agent,
    agentName: c.name,
    title: c.render.title,
    lines: c.render.lines,
    critic: c.critic,
    criticRejected: c.criticRejected,
    ownerComment: c.ownerComment,
    files: (c.files ?? []).map((f) => ({ name: f.name, mimeType: f.mimeType })),
  };
}
