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
import type { MailSender, ObjectStorage, SttProvider } from '@cms/providers';
import {
  campaignReport,
  confirmCampaign,
  runCampaign,
  sendTestEmail,
  type MailerDeps,
} from './tools/mailer.js';
import { cb } from './telegram-callbacks.js';
import {
  MEDIA_TOOL,
  ingestMedia,
  runTranscription,
  startTranscription,
  type MediaKind,
} from './tools/media.js';
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
  releaseWaitingRuns,
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
import { choosePlanner, type Pipeline, type PipelineStep } from './graph.js';
import type { AgentSelf } from './agents/context.js';
import type { CapabilityExecutor } from './executors.js';
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
import {
  agentsWithRole,
  constructorSpecOf,
  listAgents,
  resolveAgent,
  type AgentRef,
} from './agent-registry.js';
import { ROUTER_PROMPT_VERSION, runRouter, type RouteDecision } from './router.js';
import { CeoPlan, type CopyItem, type Deliverable } from './schemas.js';
import { currentPipeline, loadWorkspace } from './workspace.js';

/** Critic may send a text back to the copywriter at most this many times. */
export const MAX_CRITIC_REVISIONS = 2;

const { tasks, runs, routeDecisions } = schema;
const ORCHESTRATOR: Actor = { kind: 'agent', id: 'orchestrator' };
const SYSTEM: Actor = { kind: 'system', id: 'workflow' };

export type RunInput =
  | { kind: 'plan'; ownerComment?: string | null }
  /** The step of the agent with the «copywriting» capability (writes the copy:* slots). */
  | { kind: 'copy'; inputSig?: string; reviewer?: string | null }
  | {
      kind: 'node';
      agent: string;
      inputSig: string;
      /** Older runs: a reviewer checks this step. */
      reviewed?: boolean;
      /** The reviewer that checks this step (the run also waits while it is paused). */
      reviewer?: string | null;
      rework?: {
        baseArtifactId: string;
        ownerComment: string | null;
        mode: 'revise' | 'regenerate';
      };
    }
  /** Dispatcher: who gets the result `sig` of step `agent` next (LLM; only with 2+ links). */
  | { kind: 'route'; agent: string; sig: string }
  | {
      kind: 'rework';
      reviewer?: string | null;
      deliverableId: string;
      baseArtifactId: string;
      ownerComment: string | null;
      mode: 'revise' | 'regenerate';
    }
  | { kind: 'export' }
  /** Tool step: voice/video -> text (service task kind "media"). */
  | { kind: 'transcribe'; transcriptId: string }
  /** Tool step: sending a confirmed mailing in batches (service task kind "mailing"). */
  | { kind: 'mail_send'; campaignId: string };

/** Files the owner attached to a brief (transcripts of voice messages and videos). */
export interface TaskAttachment {
  kind: 'transcript';
  id: string;
  media: MediaKind;
  name: string;
}

export interface CopyContent extends Record<string, unknown> {
  deliverable: Deliverable;
  item: CopyItem;
  /** The reviewer's verdict; null when the step goes without a reviewer. */
  critic: Verdict | null;
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
  /** Executors by agent id (tests); otherwise by the agent's capability or its fields. */
  executors?: Record<string, NodeExecutor>;
  /** Step executors by capability (image_generate, kp_draft, kp_render, ...). */
  capabilities?: Record<string, CapabilityExecutor>;
  /** Object storage with files of steps (images); copied into the export folder. */
  storage?: ObjectStorage;
  /** Speech recognition for voice/video tool steps. */
  stt?: SttProvider;
  /** Email sender (mock until the owner's "ok"). */
  mail?: MailSender;
}

export interface DecisionResult {
  ok: boolean;
  /** Short text for the button press answer. */
  message: string;
}

type TaskRow = typeof tasks.$inferSelect;
type RouteRow = typeof routeDecisions.$inferSelect;

/** How a dispatcher decision was made (route_decisions.mode). */
export type RouteMode = 'single' | 'end' | 'router' | 'fallback' | 'manual' | 'limit';

export interface RouteView {
  agent: string;
  name: string;
  /** Steps this result can go to (outgoing links in the plan). */
  candidates: { agent: string; name: string }[];
  /** Current decision: who got the result (empty = straight to you). */
  targets: string[] | null;
  mode: RouteMode | null;
  needHelp: boolean;
  reasons: Record<string, string>;
}

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
    this.gate = makeRunGate(d.db, d.llm.health);
  }

  private get budget(): BudgetContext {
    return { config: this.d.config.budget, timeZone: this.d.config.timezone };
  }

  // ---------------------------------------------------------------- owner actions

  async submitBrief(
    brandId: string,
    text: string,
    actor: Actor,
    opts: { attachments?: TaskAttachment[] } = {},
  ): Promise<{ taskId: string; planned: boolean; message: string }> {
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
      brief: opts.attachments?.length
        ? { text: brief, attachments: opts.attachments }
        : { text: brief },
      budgetUsd: this.d.config.budget.taskUsd,
      actor,
    });
    return { taskId: id, ...(await this.startPlanning(brandId, id)) };
  }

  /**
   * Why a new task cannot be planned now (no planner, several, a draft one), or null. The
   * planner is the agent with role «Планировщик» linked from «Бриф», or the only active one.
   */
  async planningProblem(brandId: string): Promise<string | null> {
    const ws = await loadWorkspace(this.d.db, brandId);
    return choosePlanner(ws.nodes, ws.links).problem ?? null;
  }

  /** Hands the task to the planner; without one the task stays in «приём» and says why. */
  private async startPlanning(brandId: string, taskId: string) {
    const ws = await loadWorkspace(this.d.db, brandId);
    const pick = choosePlanner(ws.nodes, ws.links);
    if (!pick.id) {
      await emitEvent(this.d.db, {
        brandId,
        agent: 'brief',
        taskId,
        kind: 'wait',
        text: `Задача ждёт планировщика: ${pick.problem}`,
      });
      await this.once(`task:${taskId}:no-planner`, () =>
        this.d.channel
          .send({ text: `⏸ Задача принята, но не запущена. ${pick.problem}` })
          .then(() => undefined),
      );
      return { planned: false, message: pick.problem! };
    }
    await this.startRun(brandId, taskId, pick.id, `task:${taskId}:plan:v1`, { kind: 'plan' });
    return { planned: true, message: 'Задача принята: планировщик составляет план' };
  }

  /** «Запустить планирование»: a task that waited for a planner, once there is one. */
  async retryPlanning(taskId: string, actor: Actor): Promise<DecisionResult> {
    if (actor.kind !== 'human') return { ok: false, message: 'Запустить может только владелец' };
    const task = await this.task(taskId);
    if (task.status !== 'draft') return { ok: false, message: 'Задача уже запланирована' };
    const r = await this.startPlanning(task.brandId, taskId);
    return { ok: r.planned, message: r.message };
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
      // The planner that made the plan; if it was deleted, the one chosen for new tasks.
      const ws = await loadWorkspace(this.d.db, task.brandId);
      const pick = choosePlanner(ws.nodes, ws.links);
      const planner =
        plan.agent && ws.nodes.some((n) => n.id === plan.agent) ? plan.agent : (pick.id ?? null);
      if (!planner) return { ok: false, message: `Переделать план некому: ${pick.problem}` };
      await this.startRun(
        task.brandId,
        taskId,
        planner,
        `task:${taskId}:plan:v${plan.version + 1}`,
        {
          kind: 'plan',
          ownerComment: comment ?? null,
        },
      );
      return { ok: true, message: 'Планировщик переделывает план по вашему комментарию' };
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
        reviewer: await this.reviewerOf(
          task,
          (await this.pipelineOf(task.id)).steps.find((x) => x.agent === nc.agent),
        ),
        rework: {
          baseArtifactId: artifact.id,
          ownerComment: opts.comment ?? null,
          mode: action === 'revise' ? 'revise' : 'regenerate',
        },
      });
      return { ok: true, message: action === 'revise' ? 'Отправил на правку' : 'Делаю заново' };
    }
    const content = artifact.content as CopyContent;
    const copyStep = (await this.pipelineOf(task.id)).steps.find((x) => x.agent === artifact.agent);
    await this.startRun(task.brandId, task.id, artifact.agent, `rework:${artifact.id}`, {
      kind: 'rework',
      reviewer: await this.reviewerOf(task, copyStep),
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

  /**
   * «Продолжить»: after the task was paused because the LLM provider was unavailable too long,
   * or because a step failed for good («Продолжить с этого шага»: the step runs again as a new
   * run, the finished steps are kept).
   */
  async continueTask(taskId: string, actor: Actor): Promise<DecisionResult> {
    const task = await this.task(taskId);
    if (task.pausedAt && task.pauseReason?.startsWith('step_failed:'))
      return this.retryStep(task, task.pauseReason.slice('step_failed:'.length), actor);
    if (!task.pausedAt || task.pauseReason !== 'provider_unavailable')
      return { ok: false, message: 'Задача не на паузе' };
    await resumeTask(this.d.db, taskId, actor);
    // The wait starts over: the next outage gets the full LLM_PROVIDER_WAIT_MAX_MINUTES again.
    await this.d.db
      .update(runs)
      .set({ waitingSince: null })
      .where(sql`${runs.taskId} = ${taskId} and ${runs.status} = 'queued'`);
    for (const run of await queuedRunsOfTask(this.d.db, taskId)) await this.d.enqueue(run.id);
    return { ok: true, message: 'Продолжаю с того же шага' };
  }

  private async retryStep(task: TaskRow, runId: string, actor: Actor): Promise<DecisionResult> {
    if (actor.kind !== 'human') return { ok: false, message: 'Продолжить может только владелец' };
    const [failed] = await this.d.db
      .select()
      .from(runs)
      .where(sql`${runs.id} = ${runId} and ${runs.taskId} = ${task.id}`);
    if (!failed) return { ok: false, message: 'Упавший шаг не найден' };
    // One retry run per failed run: a double press creates nothing new.
    const { run } = await createRun(this.d.db, {
      brandId: task.brandId,
      taskId: task.id,
      agent: failed.agent,
      idempotencyKey: `${failed.idempotencyKey}:again:${failed.id}`,
      input: failed.input as RunInput,
    });
    await resumeTask(this.d.db, task.id, actor);
    await this.d.db.insert(schema.auditLog).values({
      brandId: task.brandId,
      taskId: task.id,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'step_retried',
      details: { failedRunId: failed.id, runId: run.id, agent: failed.agent },
    });
    for (const r of await queuedRunsOfTask(this.d.db, task.id)) await this.d.enqueue(r.id);
    return { ok: true, message: 'Продолжаю с этого шага' };
  }

  /**
   * Queue hook: a failed step of an approved plan stops the task on that step instead of
   * failing it (the plan and the export keep the old behaviour).
   */
  readonly stopOnFailure = async (run: Run) => {
    const i = run.input as RunInput;
    if (!['copy', 'rework', 'node', 'route'].includes(i.kind)) return null;
    const agent = 'agent' in i ? i.agent : run.agent;
    const name = (await resolveAgent(this.d.db, run.brandId, agent))?.name ?? agent;
    return {
      step: i.kind === 'route' ? `${name} · диспетчер` : name,
      buttons: [[{ text: '▶️ Продолжить с этого шага', data: cb.task('rs', run.taskId) }]],
    };
  };

  /** «Проверить провайдера»: one tiny request; a success lets waiting runs go right away. */
  async checkProvider(brandId: string) {
    const r = await this.d.llm.probe(brandId);
    if (r.ok) await releaseWaitingRuns(this.d.db, this.d.enqueue);
    return r;
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
      case 'route':
        return this.routeStep(run, task, ctx, input);
      case 'export':
        return this.exportStep(run, task);
      case 'transcribe':
        return this.transcribeStep(run, rc.signal);
      case 'mail_send':
        return this.mailStep(run, rc.signal);
    }
  };

  /** Mailer dependencies for the panel (same sender and budget as the worker). */
  mailer(): MailerDeps {
    if (!this.d.mail)
      throw new PermanentError('mail_not_configured', 'Отправка писем не настроена');
    return {
      db: this.d.db,
      config: this.d.config,
      sender: this.d.mail,
      budget: this.budget,
      logger: this.d.logger,
    };
  }

  sendTestEmail(campaignId: string, actor: Actor) {
    return sendTestEmail(this.mailer(), campaignId, actor);
  }

  /** Gate: the owner's explicit «Отправить N адресам». */
  confirmCampaign(campaignId: string, recipients: number, actor: Actor) {
    return confirmCampaign(
      { ...this.mailer(), enqueue: this.d.enqueue },
      campaignId,
      recipients,
      actor,
    );
  }

  private async mailStep(run: Run, signal: AbortSignal) {
    const campaignId = (run.input as { campaignId: string }).campaignId;
    const report = await runCampaign(this.mailer(), run, signal);
    await this.once(`${run.id}:mail-report`, () =>
      this.d.channel
        .send({
          text: `✉️ Рассылка завершена: отправлено ${report.sent}, ошибок ${report.failed}, остановлено ${report.stopped}, исключено (отписка) ${report.suppressed}.`,
        })
        .then(() => undefined),
    );
    return { campaignId, ...(await campaignReport(this.d.db, campaignId)) };
  }

  /** Voice/video -> text; the owner gets the text in Telegram when it came from there. */
  private async transcribeStep(run: Run, signal: AbortSignal) {
    if (!this.d.storage || !this.d.stt)
      throw new PermanentError('stt_not_configured', 'Расшифровка не настроена в этом процессе');
    const t = await runTranscription(
      {
        db: this.d.db,
        storage: this.d.storage,
        stt: this.d.stt,
        config: this.d.config,
        budget: this.budget,
        logger: this.d.logger,
      },
      run,
      signal,
    );
    if (t.notifyChatId && t.status === 'done') {
      const text = t.text.length > 3500 ? `${t.text.slice(0, 3500)}…` : t.text;
      await this.once(`${run.id}:notify-transcript`, () =>
        this.d.channel
          .send({
            text: `🎙 Расшифровка (${Math.round(Number(t.durationSec ?? 0))} с):\n\n${text || '— тишина, текста нет —'}\n\nПолный текст и субтитры — в панели, «Расшифровки».`,
            buttons: [
              [
                { text: '📝 Сделать задачу', data: cb.transcript('tk', t.id) },
                { text: 'Оставить в расшифровках', data: cb.transcript('kp', t.id) },
              ],
            ],
          })
          .then(() => undefined),
      );
    }
    return { transcriptId: t.id, status: t.status };
  }

  /**
   * "Сделать задачу" / "Передать в Reels": a content task whose brief carries the transcript as an
   * attachment. The transcript is external data for every agent (never instructions).
   */
  async createTaskFromTranscript(
    transcriptId: string,
    actor: Actor,
    text?: string | null,
  ): Promise<DecisionResult & { taskId?: string }> {
    const [t] = await this.d.db
      .select({ tr: schema.transcripts, file: schema.mediaFiles })
      .from(schema.transcripts)
      .innerJoin(schema.mediaFiles, sql`${schema.mediaFiles.id} = ${schema.transcripts.fileId}`)
      .where(sql`${schema.transcripts.id} = ${transcriptId}`);
    if (!t) return { ok: false, message: 'Расшифровка не найдена' };
    if (t.tr.status !== 'done') return { ok: false, message: 'Расшифровка ещё не готова' };
    const media = t.file.kind as MediaKind;
    const brief =
      text?.trim() ||
      (media === 'voice'
        ? 'Задача из голосового сообщения: что нужно сделать — в расшифровке во вложении.'
        : 'Контент по видео: используй расшифровку во вложении (краткое содержание, идеи для Reels).');
    const { taskId } = await this.submitBrief(t.tr.brandId, brief, actor, {
      attachments: [{ kind: 'transcript', id: t.tr.id, media, name: t.file.originalName }],
    });
    return { ok: true, message: 'Задача создана, CEO готовит план', taskId };
  }

  /** Telegram voice / panel upload: store the file (limits checked) and queue the transcription. */
  async transcribeUpload(
    brandId: string,
    file: {
      kind: MediaKind;
      source: 'telegram' | 'panel';
      name: string;
      mimeType: string;
      data: Buffer;
    },
    actor: Actor,
    notifyChatId?: string | null,
  ): Promise<DecisionResult & { transcriptId?: string }> {
    if (!this.d.storage) return { ok: false, message: 'Хранилище не подключено' };
    const r = await ingestMedia(
      { db: this.d.db, storage: this.d.storage, config: this.d.config },
      brandId,
      file,
      actor,
    );
    if (!r.ok) return r;
    const { transcriptId } = await startTranscription(
      { db: this.d.db, config: this.d.config, enqueue: this.d.enqueue },
      brandId,
      r.fileId!,
      { notifyChatId: notifyChatId ?? null, actor },
    );
    return {
      ok: true,
      transcriptId,
      message:
        file.kind === 'voice'
          ? 'Голосовое получено, расшифровываю…'
          : 'Видео загружено, расшифровка идёт в фоне — прогресс в «Расшифровках»',
    };
  }

  /** "Отменить" a running transcription: it stops after the current chunk, the done part stays. */
  async cancelTranscript(transcriptId: string, actor: Actor): Promise<DecisionResult> {
    const rows = await this.d.db
      .update(schema.transcripts)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(
        sql`${schema.transcripts.id} = ${transcriptId} and ${schema.transcripts.status} in ('queued', 'running')`,
      )
      .returning({ brandId: schema.transcripts.brandId });
    if (!rows.length) return { ok: false, message: 'Расшифровка уже завершена' };
    await this.d.db.insert(schema.auditLog).values({
      brandId: rows[0]!.brandId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'transcript_cancelled',
      details: { transcriptId },
    });
    return { ok: true, message: 'Расшифровка остановлена, готовая часть сохранена' };
  }

  private attachmentsOf(task: TaskRow): TaskAttachment[] {
    const a = (task.brief as { attachments?: TaskAttachment[] }).attachments;
    return Array.isArray(a) ? a : [];
  }

  /** Transcript texts of the attachments (bounded), for prompts. */
  private async attachmentTexts(task: TaskRow, which?: (a: TaskAttachment) => boolean) {
    const out: { name: string; media: MediaKind; text: string }[] = [];
    for (const a of this.attachmentsOf(task).filter(which ?? (() => true))) {
      const [t] = await this.d.db
        .select({ text: schema.transcripts.text })
        .from(schema.transcripts)
        .where(
          sql`${schema.transcripts.id} = ${a.id} and ${schema.transcripts.brandId} = ${task.brandId}`,
        );
      if (t) out.push({ name: a.name, media: a.media, text: t.text.slice(0, 20000) });
    }
    return out;
  }

  private async planStep(run: Run, task: TaskRow, ctx: AgentContext, ownerComment: string | null) {
    const previous = await latestArtifact(this.d.db, task.id, 'plan');
    // The plan carries a snapshot of the board: approving the plan freezes the steps for this task.
    const sources = [...new Set(this.attachmentsOf(task).map((a) => MEDIA_TOOL[a.media]))];
    const pipeline = await currentPipeline(this.d.db, task.brandId, sources, run.agent);
    const self = await this.self(task, run.agent);
    const attachments = await this.attachmentTexts(task);
    const ws = await loadWorkspace(this.d.db, task.brandId);
    const team = pipeline.steps.map((s) => {
      const n = ws.nodes.find((x) => x.id === s.agent);
      return { name: s.name, role: n?.role ?? '' };
    });
    const result = await this.invoke(run.agent, run, task, ctx, () =>
      runCeo(
        ctx,
        {
          brief: briefText(task),
          team,
          ...(attachments.length ? { attachments } : {}),
          ...(previous ? { previousPlan: CeoPlan.parse(previous.content) } : {}),
          ...(ownerComment ? { ownerComment } : {}),
        },
        self,
      ),
    );
    const artifact = await createArtifactVersion(this.d.db, `${run.id}:plan`, {
      brandId: task.brandId,
      taskId: task.id,
      runId: run.id,
      slot: 'plan',
      kind: 'plan',
      content: { ...result.output, pipeline },
      agent: run.agent,
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
      agent: run.agent,
      taskId: task.id,
      runId: run.id,
      kind: 'plan_ready',
      text: `${self.name} · план v${artifact.version} готов, ждёт вас`,
      costUsd: result.costUsd,
    });
    return { planArtifactId: artifact.id, version: artifact.version, costUsd: result.costUsd };
  }

  private async copyStep(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    input: Extract<RunInput, { kind: 'copy' }>,
  ) {
    const plan = await this.plan(task.id);
    const step = (await this.pipelineOf(task.id)).steps.find((s) => s.agent === run.agent);
    const upstream = step ? await this.upstreamOf(task.id, step) : [];
    const reviewer =
      input.reviewer === undefined ? await this.reviewerOf(task, step) : input.reviewer;
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
        reviewer,
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
    const step = (await this.pipelineOf(task.id)).steps.find((s) => s.agent === run.agent);
    const reviewer =
      input.reviewer === undefined ? await this.reviewerOf(task, step) : input.reviewer;
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
        reviewer,
      },
    );
    await this.advance(task.id, run);
    return { artifacts: created.map((a) => a.id) };
  }

  /**
   * Writer -> reviewer loop (the agent with «copywriting» and the agent with role «Проверяющий»
   * linked to it). Every draft becomes an artifact version together with the verdict on it.
   * Failed items go back to the writer with the reviewer's issues (and the owner's comment, if
   * any) at most MAX_CRITIC_REVISIONS times. Without a reviewer the texts go as written.
   */
  private async writeAndReview(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    plan: CeoPlan,
    deliverables: Deliverable[],
    initial: Record<string, RewriteRequest>,
    from: { inputSig: string; upstream: UpstreamResult[]; reviewer: string | null },
  ): Promise<Artifact[]> {
    const writer = await this.self(task, run.agent);
    const reviewer = from.reviewer ? await this.self(task, from.reviewer) : null;
    const finals: Artifact[] = [];
    let pending = deliverables;
    let rewrites = initial;
    const ownerComments = Object.fromEntries(
      Object.entries(initial).map(([k, v]) => [k, v.ownerComment ?? null]),
    );

    for (let round = 0; round <= MAX_CRITIC_REVISIONS && pending.length > 0; round++) {
      if (round > 0) await this.moveTo(task.id, 'revision');
      const copy = await this.invoke(writer.id, run, task, ctx, () =>
        runCopywriter(
          ctx,
          {
            brief: briefText(task),
            planSummary: plan.summary,
            deliverables: pending,
            rewrites,
            upstream: from.upstream,
            step: `r${round}`,
          },
          writer,
        ),
      );
      await this.moveTo(task.id, 'in_review');
      const review = reviewer
        ? await this.invoke(reviewer.id, run, task, ctx, () =>
            runCritic(
              ctx,
              {
                brief: briefText(task),
                deliverables: pending,
                items: copy.output.items,
                step: `r${round}`,
              },
              reviewer,
            ),
          )
        : null;

      const failed: Deliverable[] = [];
      const nextRewrites: Record<string, RewriteRequest> = {};
      for (const d of pending) {
        const item = copy.output.items.find((i) => i.deliverableId === d.id)!;
        const verdict = review?.output.find((v) => v.deliverableId === d.id) ?? null;
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
            criticRejected: !!verdict && !verdict.passed && last,
            ownerComment: ownerComments[d.id] ?? null,
            inputSig: from.inputSig,
          } satisfies CopyContent,
          agent: writer.id,
          promptVersion: review
            ? `${copy.promptVersion}+${review.promptVersion}`
            : copy.promptVersion,
          model: copy.model,
        });
        if (!verdict || verdict.passed || last) finals.push(artifact);
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
      if (review && reviewer) {
        const passedN = pending.length - failed.length;
        await emitEvent(this.d.db, {
          brandId: task.brandId,
          agent: reviewer.id,
          taskId: task.id,
          runId: run.id,
          kind: 'verdict',
          text:
            failed.length === 0
              ? `${reviewer.name} · вердикт: принято (${passedN})`
              : `${reviewer.name} · вердикт: доработать ${failed.length}${passedN ? `, принято ${passedN}` : ''}`,
          costUsd: review.costUsd,
        });
      }
      pending = failed;
      rewrites = nextRewrites;
    }
    // Show items to the owner in plan order, not in the order the reviewer passed them.
    const order = deliverables.map((d) => `copy:${d.id}`);
    return finals.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  }

  // ---------------------------------------------------------------- graph execution

  /**
   * Steps of this task: the board snapshot stored in the plan. Plans made before the board
   * existed have none: the texts are written by the agent with «copywriting», checked by the
   * reviewer it is linked to.
   */
  private async pipelineOf(taskId: string): Promise<Pipeline> {
    const a = await latestArtifact(this.d.db, taskId, 'plan');
    const p = (a?.content as { pipeline?: Pipeline } | undefined)?.pipeline;
    if (p?.steps?.length) return p;
    const task = await this.task(taskId);
    const ws = await loadWorkspace(this.d.db, task.brandId);
    const writer = ws.nodes.find((n) => n.capability === 'copywriting' && n.status === 'active');
    return {
      steps: writer
        ? [
            {
              agent: writer.id,
              name: writer.name,
              after: [],
              reviewed: true,
              capability: 'copywriting',
            },
          ]
        : [],
      inactive: [],
      links: ws.links.map((l) => ({ from: l.from, to: l.to })),
    };
  }

  /** The agent record a call runs as (deleted agents keep their name for the history). */
  private async self(task: TaskRow, agentId: string): Promise<AgentSelf> {
    const ref = await resolveAgent(this.d.db, task.brandId, agentId);
    if (!ref)
      throw new PermanentError('agent_missing', `Агента «${agentId}» нет на доске (удалён?)`);
    return { id: ref.id, name: ref.name };
  }

  /**
   * Who reviews a step: the reviewer stored in the plan; plans made before stage 7 only say
   * «reviewed» — then the active agent with role «Проверяющий» linked to the step (or the only one).
   */
  private async reviewerOf(task: TaskRow, step: PipelineStep | undefined): Promise<string | null> {
    if (!step) return null;
    if (step.reviewer !== undefined) return step.reviewer;
    if (!step.reviewed) return null;
    const reviewers = (await agentsWithRole(this.d.db, task.brandId, 'reviewer')).filter(
      (r) => r.status === 'active',
    );
    const ws = await loadWorkspace(this.d.db, task.brandId);
    const linked = reviewers.filter((r) =>
      ws.links.some((l) => l.from === step.agent && l.to === r.id),
    );
    return (
      (linked.length === 1 ? linked[0] : reviewers.length === 1 ? reviewers[0] : null)?.id ?? null
    );
  }

  /** The step runs the «copywriting» capability (the copy:* slots). */
  private async isCopyStep(taskId: string, agent: string): Promise<boolean> {
    const step = (await this.pipelineOf(taskId)).steps.find((s) => s.agent === agent);
    if (step?.capability !== undefined) return step.capability === 'copywriting';
    const task = await this.task(taskId);
    return (await resolveAgent(this.d.db, task.brandId, agent))?.capability === 'copywriting';
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
    return (await this.isCopyStep(taskId, agent))
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
    // Attachments: to the steps linked from their source tool; without such links — to the
    // first steps (the ones that start right after the plan).
    const task = await this.task(taskId);
    if (this.attachmentsOf(task).length) {
      const pipe = await this.pipelineOf(taskId);
      const consumed = new Set(pipe.steps.flatMap((x) => x.inputs ?? []));
      // The source agent of an attachment: by its capability (older plans used the capability id).
      const sourceOf = (media: MediaKind) =>
        pipe.sources?.find((x) => x.capability === MEDIA_TOOL[media])?.agent ?? MEDIA_TOOL[media];
      const texts = await this.attachmentTexts(task, (a) => {
        const src = sourceOf(a.media);
        return consumed.has(src) ? (step.inputs ?? []).includes(src) : step.after.length === 0;
      });
      for (const t of texts)
        out.push({
          agent: sourceOf(t.media),
          name: t.media === 'voice' ? 'Расшифровка голосового' : 'Расшифровка видео',
          items: [{ file: t.name, text: t.text }],
        });
    }
    for (const dep of await this.forwardingDeps(taskId, step)) {
      const arts = await this.stepArtifacts(taskId, dep);
      if (await this.isCopyStep(taskId, dep)) {
        out.push({
          agent: dep,
          name: (await this.pipelineOf(taskId)).steps.find((x) => x.agent === dep)?.name ?? dep,
          items: arts.map((a) => {
            const c = a.content as CopyContent;
            return {
              deliverable: c.deliverable,
              variants: c.item.variants,
              ...(c.critic ? { critic: c.critic.summary } : {}),
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
      .select({ id: runs.id, input: runs.input, agent: runs.agent })
      .from(runs)
      .where(sql`${runs.taskId} = ${taskId} and ${runs.status} in ('queued', 'running')`);
    const out = new Set<string>();
    for (const r of rows) {
      if (r.id === exceptRunId) continue;
      const i = r.input as RunInput;
      if (i.kind === 'copy' || i.kind === 'rework') out.add(r.agent);
      else if (i.kind === 'node') out.add(i.agent);
      else if (i.kind === 'route') out.add(`route:${i.agent}`);
    }
    return out;
  }

  /**
   * Drives the graph after the plan is approved and after every step. Each step that finished
   * gets a dispatcher decision (who receives its result): no next step -> «Вы»; one -> handed on
   * without the LLM; two or more -> the router run decides. A step starts once every step before
   * it is decided and at least one of them handed it the result; a step nobody handed anything
   * to is skipped. A step re-runs when its input changed (e.g. a text was revised). Finished
   * results are shown to the owner, and the task goes to gate 2 when every step is decided or
   * skipped. Safe to call repeatedly.
   */
  private async advance(taskId: string, current: Run | null): Promise<void> {
    const task = await this.task(taskId);
    if (!['in_progress', 'in_review', 'revision', 'awaiting_final_approval'].includes(task.status))
      return;
    const pipe = await this.pipelineOf(taskId);
    const planArt = await latestArtifact(this.d.db, taskId, 'plan');
    const active = await this.activeSteps(taskId, current?.id ?? null);
    const decisions = await this.decisionsOf(taskId);
    type StepState = {
      /** Decided (or skipped): nothing more will happen to this step's result. */
      resolved: boolean;
      skipped: boolean;
      arts: Artifact[];
      forwards: string[];
    };
    const state = new Map<string, StepState>();
    const pending: StepState = { resolved: false, skipped: false, arts: [], forwards: [] };
    for (const step of pipe.steps) {
      const deps = step.after.map((d) => state.get(d) ?? pending);
      if (!deps.every((d) => d.resolved)) {
        state.set(step.agent, pending);
        continue;
      }
      const from = step.after.filter((d) => state.get(d)!.forwards.includes(step.agent));
      if (step.after.length > 0 && from.length === 0) {
        state.set(step.agent, { resolved: true, skipped: true, arts: [], forwards: [] });
        continue;
      }
      const sig = Workflow.sigOf(from.flatMap((d) => state.get(d)!.arts));
      const arts = await this.stepArtifacts(taskId, step.agent);
      const fresh =
        arts.length > 0 &&
        arts.every((a) => ((a.content as { inputSig?: string }).inputSig ?? 'root') === sig);
      if (active.has(step.agent) || active.has(`route:${step.agent}`)) {
        state.set(step.agent, pending);
        continue;
      }
      if (!fresh) {
        const reviewer = await this.reviewerOf(task, step);
        if (await this.isCopyStep(taskId, step.agent)) {
          await this.startRun(
            task.brandId,
            taskId,
            step.agent,
            `task:${taskId}:copy:plan-v${planArt?.version ?? 1}${sig === 'root' ? '' : `:${sig}`}`,
            { kind: 'copy', inputSig: sig, reviewer },
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
              reviewed: reviewer !== null,
              reviewer,
            },
          );
        }
        active.add(step.agent);
        state.set(step.agent, pending);
        continue;
      }
      const own = Workflow.sigOf(arts);
      const decision =
        decisions.get(`${step.agent}:${own}`) ?? (await this.decideFixed(task, pipe, step, own));
      if (!decision) {
        // Two or more next steps: the router decides in its own run.
        await this.startRun(
          task.brandId,
          taskId,
          step.agent,
          `task:${taskId}:route:${step.agent}:${own}`,
          { kind: 'route', agent: step.agent, sig: own },
        );
        active.add(`route:${step.agent}`);
        state.set(step.agent, pending);
        continue;
      }
      state.set(step.agent, {
        resolved: true,
        skipped: false,
        arts,
        forwards: decision.targets as string[],
      });
    }

    const settled = (agent: string) => state.get(agent)?.resolved === true;
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

  // ---------------------------------------------------------------- dispatcher

  /** Steps that receive `agent`'s result (its outgoing links in the plan snapshot). */
  private static nextSteps(pipe: Pipeline, agent: string): PipelineStep[] {
    return pipe.steps.filter((s) => s.after.includes(agent));
  }

  private async decisionsOf(taskId: string): Promise<Map<string, RouteRow>> {
    const rows = await this.d.db
      .select()
      .from(routeDecisions)
      .where(sql`${routeDecisions.taskId} = ${taskId}`);
    return new Map(rows.map((r) => [`${r.fromAgent}:${r.fromSig}`, r]));
  }

  /** Steps before `step` that handed it their current result (all of them for old tasks). */
  private async forwardingDeps(taskId: string, step: PipelineStep): Promise<string[]> {
    if (step.after.length === 0) return [];
    const decisions = await this.decisionsOf(taskId);
    const out: string[] = [];
    for (const dep of step.after) {
      const sig = Workflow.sigOf(await this.stepArtifacts(taskId, dep));
      const d = decisions.get(`${dep}:${sig}`);
      if (!d || (d.targets as string[]).includes(step.agent)) out.push(dep);
    }
    return out;
  }

  /**
   * Hand-offs used since the owner's last decision (plan approval, item decision). The limit
   * stops a runaway chain; every owner decision gives the task a fresh allowance.
   */
  private async hopsUsed(taskId: string): Promise<number> {
    const { rows } = await this.d.db.execute<{ n: number }>(sql`
      select coalesce(sum(jsonb_array_length(d.targets)), 0)::int as n
      from route_decisions d
      where d.task_id = ${taskId} and d.mode <> 'manual'
        and d.created_at > coalesce(
          (select max(a.created_at) from approvals a where a.task_id = ${taskId}),
          '-infinity'::timestamptz)`);
    return rows[0]?.n ?? 0;
  }

  /** Decisions that need no LLM: no next step (-> «Вы») or exactly one. Null: the router decides. */
  private async decideFixed(
    task: TaskRow,
    pipe: Pipeline,
    step: PipelineStep,
    sig: string,
  ): Promise<RouteRow | null> {
    const next = Workflow.nextSteps(pipe, step.agent);
    if (next.length > 1) return null;
    return this.saveDecision(task, pipe, {
      fromAgent: step.agent,
      fromSig: sig,
      targets: next.map((s) => s.agent),
      mode: next.length ? 'single' : 'end',
      reasons: next.length ? { [next[0]!.agent]: 'единственная связь на доске' } : {},
      confidence: null,
      needHelp: false,
      decidedBy: 'dispatcher',
    });
  }

  /**
   * Stores a decision once per (task, step, result): audit_log + a "handoff" event for the board.
   * The hop limit cuts the targets; then the task goes to the owner with what is ready.
   */
  private async saveDecision(
    task: TaskRow,
    pipe: Pipeline,
    d: {
      fromAgent: string;
      fromSig: string;
      targets: string[];
      mode: RouteMode;
      reasons: Record<string, string>;
      confidence: number | null;
      needHelp: boolean;
      decidedBy: string;
      runId?: string | null;
      costUsd?: number | null;
    },
    actor: Actor = SYSTEM,
  ): Promise<RouteRow> {
    let { targets, mode } = d;
    const max = this.d.config.routing.maxHops;
    if (mode !== 'manual' && targets.length > 0) {
      const left = Math.max(0, max - (await this.hopsUsed(task.id)));
      if (targets.length > left) {
        targets = targets.slice(0, left);
        mode = 'limit';
      }
    }
    const values = {
      taskId: task.id,
      fromAgent: d.fromAgent,
      fromSig: d.fromSig,
      targets,
      mode,
      reasons: d.reasons,
      confidence: d.confidence == null ? null : d.confidence.toFixed(3),
      needHelp: d.needHelp,
      decidedBy: d.decidedBy,
    };
    const [row] =
      mode === 'manual'
        ? await this.d.db
            .insert(routeDecisions)
            .values(values)
            .onConflictDoUpdate({
              target: [routeDecisions.taskId, routeDecisions.fromAgent, routeDecisions.fromSig],
              set: { ...values, updatedAt: sql`now()` },
            })
            .returning()
        : await this.d.db.insert(routeDecisions).values(values).onConflictDoNothing().returning();
    if (!row) {
      const [existing] = await this.d.db
        .select()
        .from(routeDecisions)
        .where(
          sql`${routeDecisions.taskId} = ${task.id} and ${routeDecisions.fromAgent} = ${d.fromAgent} and ${routeDecisions.fromSig} = ${d.fromSig}`,
        );
      return existing!;
    }
    const name = (id: string) => pipe.steps.find((s) => s.agent === id)?.name ?? id;
    const why = targets.length === 1 ? d.reasons[targets[0]!] : null;
    const text =
      mode === 'limit'
        ? `${name(d.fromAgent)} → ${targets.length ? targets.map(name).join(', ') : 'Вы'}: достигнут лимит передач (${max}), дальше — к вам с тем, что готово`
        : d.needHelp
          ? `${name(d.fromAgent)}: диспетчер не уверен, кому передать результат — решите сами («Передать другому»)`
          : `${name(d.fromAgent)} → ${targets.length ? targets.map(name).join(', ') : 'Вы'}${why ? `: ${why}` : ''}${mode === 'manual' ? ' (вручную)' : ''}`;
    await this.d.db.insert(schema.auditLog).values({
      brandId: task.brandId,
      taskId: task.id,
      actorKind: actor.kind,
      actorId: actor.id,
      action: mode === 'manual' ? 'route_manual' : 'route_decided',
      details: {
        from: d.fromAgent,
        fromSig: d.fromSig,
        to: targets,
        mode,
        reasons: d.reasons,
        confidence: d.confidence,
        needHelp: d.needHelp,
      },
    });
    await emitEvent(
      this.d.db,
      {
        brandId: task.brandId,
        agent: d.fromAgent,
        taskId: task.id,
        runId: d.runId ?? null,
        kind: 'handoff',
        text,
        costUsd: d.costUsd ?? null,
        payload: {
          to: targets.length ? targets : ['me'],
          mode,
          reasons: d.reasons,
          confidence: d.confidence,
          needHelp: d.needHelp,
        },
      },
      this.d.logger,
    );
    return row;
  }

  /** The router run: the LLM picks the next steps among the outgoing links of the plan. */
  private async routeStep(
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    input: Extract<RunInput, { kind: 'route' }>,
  ) {
    const pipe = await this.pipelineOf(task.id);
    const step = pipe.steps.find((s) => s.agent === input.agent);
    if (!step) throw new PermanentError('step_missing', `Step ${input.agent} is not in the plan`);
    const arts = await this.stepArtifacts(task.id, input.agent);
    if (Workflow.sigOf(arts) !== input.sig) {
      // The result changed while this run waited: a new decision is made for the new result.
      await this.advance(task.id, run);
      return { skipped: 'result changed' };
    }
    const next = Workflow.nextSteps(pipe, input.agent);
    const refs = await listAgents(this.d.db, task.brandId);
    const candidates = next.map((s) => {
      const r = refs.find((x) => x.id === s.agent);
      const when = r?.spec.whenToCall;
      return {
        id: s.agent,
        name: s.name,
        role: r?.role ?? '',
        description: r?.description ?? '',
        whenToCall: typeof when === 'string' ? when : null,
      };
    });
    let res: { output: RouteDecision; costUsd: number } | null = null;
    try {
      res = await invokeAgent(
        this.d.db,
        { id: input.agent, name: `${step.name} · диспетчер` },
        {
          brandId: task.brandId,
          taskId: task.id,
          runId: run.id,
          model: ctx.models.classifier,
          promptVersion: ROUTER_PROMPT_VERSION,
        },
        () =>
          runRouter(ctx, {
            brief: briefText(task),
            from: { id: input.agent, name: step.name },
            result: arts.map((a) => {
              const c = a.content as Partial<CopyContent & NodeContent>;
              return c.output ?? { deliverable: c.deliverable?.id, variants: c.item?.variants };
            }),
            candidates,
            step: input.sig,
          }),
      );
    } catch (err) {
      // A choice outside the links even after 2 corrections: hand on by the links instead.
      if (!(err instanceof PermanentError && err.code === 'llm_invalid_output')) throw err;
      this.d.logger.warn({ taskId: task.id, agent: input.agent }, 'router failed; using links');
    }
    const out = res?.output;
    const needHelp = out?.decision === 'need_help';
    const targets = !out
      ? next.map((s) => s.agent)
      : out.decision === 'forward'
        ? out.targets.map((t) => t.agent)
        : [];
    const reasons: Record<string, string> = !out
      ? Object.fromEntries(next.map((s) => [s.agent, 'диспетчер не смог выбрать — по связям']))
      : Object.fromEntries(out.targets.map((t) => [t.agent, t.reason]));
    // SEO cannot be bypassed on the way to the owner.
    // An acceptor (role «Приёмка», e.g. SEO) linked after this step cannot be bypassed.
    for (const req of next.filter(
      (x) => refs.find((r) => r.id === x.agent)?.teamRole === 'acceptor',
    )) {
      if (!needHelp && !targets.includes(req.agent)) {
        targets.push(req.agent);
        reasons[req.agent] = `«${req.name}» (приёмка) обязательна перед согласованием`;
      }
    }
    const row = await this.saveDecision(task, pipe, {
      fromAgent: input.agent,
      fromSig: input.sig,
      targets,
      mode: out ? 'router' : 'fallback',
      reasons,
      confidence: out?.confidence ?? null,
      needHelp,
      decidedBy: out ? `router:${ctx.models.classifier}` : 'dispatcher',
      runId: run.id,
      costUsd: res?.costUsd ?? null,
    });
    if (needHelp)
      await this.once(`${run.id}:route-help`, () =>
        this.d.channel
          .send({
            text: `🤔 «${task.title}»: диспетчер не уверен, кому передать результат шага «${step.name}». Остальное идёт к вам; если нужно, передайте вручную в панели («Передать другому»).`,
          })
          .then(() => undefined),
      );
    await this.advance(task.id, run);
    return { targets: row.targets, mode: row.mode, costUsd: res?.costUsd ?? 0 };
  }

  /** «Передать другому»: the owner picks who gets a step's current result (empty = to «Вы»). */
  async forwardManually(
    taskId: string,
    from: string,
    to: string[],
    actor: Actor,
  ): Promise<DecisionResult> {
    if (actor.kind !== 'human')
      return { ok: false, message: 'Передавать вручную может только владелец' };
    const task = await this.task(taskId);
    if (!['in_progress', 'in_review', 'revision', 'awaiting_final_approval'].includes(task.status))
      return { ok: false, message: 'Задача сейчас не выполняется' };
    const pipe = await this.pipelineOf(taskId);
    const step = pipe.steps.find((s) => s.agent === from);
    if (!step) return { ok: false, message: 'Такого шага нет в плане задачи' };
    const next = Workflow.nextSteps(pipe, from).map((s) => s.agent);
    const bad = to.filter((t) => !next.includes(t));
    if (bad.length)
      return {
        ok: false,
        message: `Передать можно только по связям из плана: ${next.length ? next.join(', ') : 'дальше связей нет'}`,
      };
    const arts = await this.stepArtifacts(taskId, from);
    if (arts.length === 0) return { ok: false, message: 'У шага ещё нет результата' };
    await this.saveDecision(
      task,
      pipe,
      {
        fromAgent: from,
        fromSig: Workflow.sigOf(arts),
        targets: [...new Set(to)],
        mode: 'manual',
        reasons: Object.fromEntries(to.map((t) => [t, 'решение владельца'])),
        confidence: null,
        needHelp: false,
        decidedBy: `${actor.kind}:${actor.id}`,
      },
      actor,
    );
    if (task.status === 'awaiting_final_approval' && to.length > 0)
      await transitionTask(this.d.db, {
        taskId,
        to: 'revision',
        actor,
        reason: `forward ${from}`,
        details: { from, to },
      });
    await this.advance(taskId, null);
    return {
      ok: true,
      message: to.length
        ? `Передал: ${to.map((t) => pipe.steps.find((s) => s.agent === t)?.name ?? t).join(', ')}`
        : 'Результат идёт к вам',
    };
  }

  /** For the panel: each finished step, where its result went and where it could go. */
  async routes(taskId: string): Promise<RouteView[]> {
    const pipe = await this.pipelineOf(taskId);
    const decisions = await this.decisionsOf(taskId);
    const out: RouteView[] = [];
    for (const step of pipe.steps) {
      const arts = await this.stepArtifacts(taskId, step.agent);
      if (arts.length === 0) continue;
      const d = decisions.get(`${step.agent}:${Workflow.sigOf(arts)}`);
      out.push({
        agent: step.agent,
        name: step.name,
        candidates: Workflow.nextSteps(pipe, step.agent).map((s) => ({
          agent: s.agent,
          name: s.name,
        })),
        targets: d ? (d.targets as string[]) : null,
        mode: (d?.mode as RouteMode | undefined) ?? null,
        needHelp: d?.needHelp ?? false,
        reasons: (d?.reasons as Record<string, string> | undefined) ?? {},
      });
    }
    return out;
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
    const reviewerId =
      input.reviewer !== undefined
        ? input.reviewer
        : input.reviewed
          ? await this.reviewerOf(task, step)
          : null;
    const reviewer = reviewerId && exec.review ? await this.self(task, reviewerId) : null;
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
      const review = reviewer
        ? await this.invoke(reviewer.id, run, task, ctx, () =>
            exec.review!(ctx, nodeInput, res.output, reviewer),
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
      if (verdict && reviewer) {
        await emitEvent(this.d.db, {
          brandId: task.brandId,
          agent: reviewer.id,
          taskId: task.id,
          runId: run.id,
          kind: 'verdict',
          text: `${reviewer.name} · ${step.name}: ${verdict.passed ? 'принято' : 'доработать'}`,
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
  /** A step runs by the agent's capability (code), or as an LLM agent by its fields. */
  private async registryExecutor(task: TaskRow, agentId: string): Promise<NodeExecutor | null> {
    const ref = await resolveAgent(this.d.db, task.brandId, agentId);
    if (!ref) return null;
    if (ref.capability) return this.capabilityExecutor(ref);
    const { spec } = constructorSpecOf(ref);
    if (!spec) return null;
    return constructorExecutor({ id: ref.id, name: ref.name, role: ref.role, spec });
  }

  private capabilityExecutor(ref: AgentRef): NodeExecutor | null {
    const make = ref.capability ? this.d.capabilities?.[ref.capability] : undefined;
    return make ? make({ id: ref.id, name: ref.name }) : null;
  }

  /** Every agent call goes through the registry + invocation log (code and board agents). */
  private async invoke<T>(
    agentId: string,
    run: Run,
    task: TaskRow,
    ctx: AgentContext,
    fn: () => Promise<AgentResult<T>>,
  ) {
    const node = (await loadWorkspace(this.d.db, task.brandId)).nodes.find((n) => n.id === agentId);
    if (!node) throw new PermanentError('unknown_agent', `Агента «${agentId}» нет на доске`);
    const role = node.modelRole as keyof AgentContext['models'] | null;
    const prompt = ctx.prompts[agentId];
    return invokeAgent(
      this.d.db,
      { id: agentId, name: node.name },
      {
        brandId: task.brandId,
        taskId: task.id,
        runId: run.id,
        model: ctx.agentModels[agentId] ?? (role ? ctx.models[role] : 'tool'),
        promptVersion: prompt?.version ?? `${agentId}@tool`,
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
