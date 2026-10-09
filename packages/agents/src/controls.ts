import type { Actor, AppConfig, LlmConfig, Logger, ModelPricing } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import { releaseWaitingRuns, type Run } from '@cms/engine';
import { AGENTS, agentById, type AgentDefinition } from './registry.js';
import {
  activatePromptVersion,
  activePrompts,
  savePromptVersion,
  type ActivePrompt,
  type PromptChange,
} from './prompt-store.js';
import type { AgentName } from './prompts.js';

const { agentSettings, globalControls, auditLog } = schema;

export interface ControlResult {
  ok: boolean;
  message: string;
}

export interface AgentControlState {
  paused: boolean;
  disabled: boolean;
  modelOverride: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface ControlState {
  allPaused: boolean;
  changedBy: string | null;
  changedAt: Date | null;
  agents: Record<string, AgentControlState>;
}

const DEFAULT_AGENT: AgentControlState = {
  paused: false,
  disabled: false,
  modelOverride: null,
  updatedBy: null,
  updatedAt: null,
};

/** Agents a run will call, by run kind. A run waits while any of them is paused or disabled. */
export function agentsForRun(run: Pick<Run, 'input'>): AgentName[] {
  switch ((run.input as { kind?: string } | null)?.kind) {
    case 'plan':
      return ['ceo'];
    case 'copy':
    case 'rework':
      return ['copywriter', 'critic'];
    default:
      return []; // export: no agent involved
  }
}

export async function getControlState(db: Db, brandId: string): Promise<ControlState> {
  const [g] = await db
    .select()
    .from(globalControls)
    .where(sql`${globalControls.brandId} = ${brandId}`);
  const rows = await db
    .select()
    .from(agentSettings)
    .where(sql`${agentSettings.brandId} = ${brandId}`);
  const agents: Record<string, AgentControlState> = {};
  for (const def of AGENTS) agents[def.id] = { ...DEFAULT_AGENT };
  for (const r of rows) {
    agents[r.agent] = {
      paused: r.paused,
      disabled: r.disabled,
      modelOverride: r.modelOverride,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    };
  }
  return {
    allPaused: g?.allPaused ?? false,
    changedBy: g?.changedBy ?? null,
    changedAt: g?.changedAt ?? null,
    agents,
  };
}

/** Queue gate: what a run waits for ("all", "agent:copywriter") or null when it may start. */
export function makeRunGate(db: Db) {
  return async (run: Run): Promise<string | null> => {
    const state = await getControlState(db, run.brandId);
    if (state.allPaused) return 'all';
    for (const a of agentsForRun(run)) {
      const s = state.agents[a];
      if (s?.paused || s?.disabled) return `agent:${a}`;
    }
    return null;
  };
}

export interface ControlsDeps {
  db: Db;
  config: AppConfig;
  pricing: ModelPricing;
  enqueue: (runId: string) => Promise<unknown>;
  logger: Logger;
}

/**
 * Owner's controls over agents: pause/resume, on/off, "stop everything", model override
 * (only models from the price list), prompt versions. Every change is written to audit_log.
 * Used by the panel API; the workflow reads effective models and prompts through it.
 */
export class AgentControls {
  constructor(private readonly d: ControlsDeps) {}

  /** Models the owner may choose: exactly the models of the active price list. */
  allowedModels(): string[] {
    return Object.keys(this.d.pricing.models).sort();
  }

  /** LLM_MODEL_* from .env with per-agent overrides from the panel applied. */
  async effectiveModels(brandId: string): Promise<LlmConfig['models']> {
    const state = await getControlState(this.d.db, brandId);
    const models = { ...this.d.config.llm.models };
    for (const def of AGENTS) {
      const override = state.agents[def.id]?.modelOverride;
      // An override that is no longer in the price list (provider changed) is not used.
      if (override && this.allowedModels().includes(override)) models[def.modelRole] = override;
    }
    return models;
  }

  async modelOf(brandId: string, def: AgentDefinition) {
    const state = await getControlState(this.d.db, brandId);
    const stored = state.agents[def.id]?.modelOverride ?? null;
    const override = stored && this.allowedModels().includes(stored) ? stored : null;
    const env = this.d.config.llm.models[def.modelRole];
    return {
      name: override ?? env,
      env,
      source: override ? ('panel' as const) : ('.env' as const),
      /** Panel model that is not in the current price list (e.g. after switching provider). */
      ignoredOverride: stored && !override ? stored : null,
    };
  }

  prompts(brandId: string): Promise<Record<AgentName, ActivePrompt>> {
    return activePrompts(this.d.db, brandId);
  }

  // ------------------------------------------------------------------ pause / on-off

  async setPaused(brandId: string, agentId: string, paused: boolean, actor: Actor) {
    const def = agentById(agentId);
    if (!def) return { ok: false, message: 'Нет такого агента' };
    const changed = await this.updateAgent(brandId, def.id, { paused }, actor, (s) =>
      s.paused === paused ? null : paused ? 'agent_paused' : 'agent_resumed',
    );
    if (!changed) return { ok: false, message: paused ? 'Уже на паузе' : 'Агент не на паузе' };
    if (!paused) await this.release();
    return {
      ok: true,
      message: paused
        ? `${def.name} на паузе: новые запуски ждут в очереди, текущий доработает`
        : `${def.name} продолжает работу, очередь разбирается`,
    };
  }

  async setDisabled(brandId: string, agentId: string, disabled: boolean, actor: Actor) {
    const def = agentById(agentId);
    if (!def) return { ok: false, message: 'Нет такого агента' };
    const changed = await this.updateAgent(brandId, def.id, { disabled }, actor, (s) =>
      s.disabled === disabled ? null : disabled ? 'agent_disabled' : 'agent_enabled',
    );
    if (!changed) return { ok: false, message: disabled ? 'Уже выключен' : 'Уже включён' };
    if (!disabled) await this.release();
    return {
      ok: true,
      message: disabled
        ? `${def.name} выключен: его запуски ждут, пока вы его не включите`
        : `${def.name} включён`,
    };
  }

  async setAllPaused(brandId: string, allPaused: boolean, actor: Actor): Promise<ControlResult> {
    const changed = await this.d.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`controls:${brandId}`}))`);
      const [g] = await tx
        .select()
        .from(globalControls)
        .where(sql`${globalControls.brandId} = ${brandId}`);
      if ((g?.allPaused ?? false) === allPaused) return false;
      await tx
        .insert(globalControls)
        .values({ brandId, allPaused, changedBy: actor.id })
        .onConflictDoUpdate({
          target: globalControls.brandId,
          set: { allPaused, changedBy: actor.id, changedAt: sql`now()` },
        });
      await tx.insert(auditLog).values({
        brandId,
        actorKind: actor.kind,
        actorId: actor.id,
        action: allPaused ? 'stop_all' : 'resume_all',
        details: {},
      });
      return true;
    });
    if (!changed)
      return { ok: false, message: allPaused ? 'Уже всё остановлено' : 'Ничего не остановлено' };
    if (!allPaused) await this.release();
    return {
      ok: true,
      message: allPaused
        ? 'Все агенты остановлены: новые запуски ждут, текущие доработают'
        : 'Агенты снова работают, очередь разбирается',
    };
  }

  // ------------------------------------------------------------------ model

  async setModel(brandId: string, agentId: string, model: string, actor: Actor) {
    const def = agentById(agentId);
    if (!def) return { ok: false, message: 'Нет такого агента' };
    if (!this.allowedModels().includes(model))
      return { ok: false, message: `Модели ${model} нет в прайс-листе — выбрать её нельзя` };
    return this.changeModel(brandId, def, model, actor);
  }

  resetModel(brandId: string, agentId: string, actor: Actor) {
    const def = agentById(agentId);
    if (!def) return Promise.resolve({ ok: false, message: 'Нет такого агента' });
    return this.changeModel(brandId, def, null, actor);
  }

  private async changeModel(
    brandId: string,
    def: AgentDefinition,
    override: string | null,
    actor: Actor,
  ): Promise<ControlResult> {
    const before = await this.modelOf(brandId, def);
    const env = this.d.config.llm.models[def.modelRole];
    const after = override ?? env;
    if (
      !before.ignoredOverride &&
      before.source === (override ? 'panel' : '.env') &&
      before.name === after
    )
      return { ok: false, message: 'Модель не изменилась' };
    await this.updateAgent(brandId, def.id, { modelOverride: override }, actor, () => ({
      action: 'agent_model_changed',
      details: {
        from: before.name,
        fromSource: before.source,
        to: after,
        toSource: override ? 'panel' : '.env',
      },
    }));
    return {
      ok: true,
      message: override
        ? `${def.name}: модель ${after} (из панели), действует со следующего запуска`
        : `${def.name}: модель снова из .env (${env})`,
    };
  }

  // ------------------------------------------------------------------ prompts

  savePrompt(brandId: string, agentId: string, text: string, actor: Actor): Promise<PromptChange> {
    const def = agentById(agentId);
    if (!def) return Promise.resolve({ ok: false, message: 'Нет такого агента' });
    return savePromptVersion(this.d.db, brandId, def.prompt, text, actor);
  }

  activatePrompt(brandId: string, agentId: string, versionId: string, actor: Actor) {
    const def = agentById(agentId);
    if (!def) return Promise.resolve({ ok: false, message: 'Нет такого агента' });
    return activatePromptVersion(this.d.db, brandId, def.prompt, versionId, actor);
  }

  // ------------------------------------------------------------------ helpers

  /** Held runs are delivered again; those still blocked are held again by the gate. */
  private async release() {
    const n = await releaseWaitingRuns(this.d.db, this.d.enqueue);
    if (n > 0) this.d.logger.info({ runs: n }, 'waiting runs released');
  }

  /**
   * Upserts one agent's settings under a lock and writes the audit row. `audit` gets the
   * state before the change and returns the action (or action + details), or null = no-op.
   */
  private async updateAgent(
    brandId: string,
    agent: string,
    patch: Partial<Pick<AgentControlState, 'paused' | 'disabled' | 'modelOverride'>>,
    actor: Actor,
    audit: (
      before: AgentControlState,
    ) => string | { action: string; details: Record<string, unknown> } | null,
  ): Promise<boolean> {
    return this.d.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`controls:${brandId}`}))`);
      const [row] = await tx
        .select()
        .from(agentSettings)
        .where(sql`${agentSettings.brandId} = ${brandId} and ${agentSettings.agent} = ${agent}`);
      const before: AgentControlState = row
        ? { ...row, updatedAt: row.updatedAt }
        : { ...DEFAULT_AGENT };
      const a = audit(before);
      if (!a) return false;
      const { action, details } = typeof a === 'string' ? { action: a, details: {} } : a;
      await tx
        .insert(agentSettings)
        .values({ brandId, agent, ...patch, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: [agentSettings.brandId, agentSettings.agent],
          set: { ...patch, updatedBy: actor.id, updatedAt: sql`now()` },
        });
      await tx.insert(auditLog).values({
        brandId,
        actorKind: actor.kind,
        actorId: actor.id,
        action,
        details: { agent, ...details },
      });
      return true;
    });
  }
}
