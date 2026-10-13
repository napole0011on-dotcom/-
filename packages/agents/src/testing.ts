/** Test helpers for the agents package (not part of the build). */
import { schema, type Db } from '@cms/db';
import { activateConstructorAgent, resolveAgent } from './agent-registry.js';
import { runAgentTest, type AgentTestDeps } from './agent-test.js';
import { addFromTemplate, loadLibraryFiles, syncLibrary } from './library.js';
import { savePromptVersion } from './prompt-store.js';
import { BRIEF, OWNER } from './graph.js';
import { loadWorkspace, placeNewNode } from './workspace.js';
import type { NotifierMessage } from '@cms/providers';
import type { ExportView, OwnerChannel, PackageView, PlanView } from './channel.js';

export class RecordingChannel implements OwnerChannel {
  readonly name = 'recording';
  readonly plans: PlanView[] = [];
  readonly packages: PackageView[] = [];
  readonly exports: ExportView[] = [];
  readonly messages: NotifierMessage[] = [];

  send(msg: NotifierMessage) {
    this.messages.push(msg);
    return Promise.resolve({ messageId: String(this.messages.length) });
  }
  sendPlan(v: PlanView) {
    this.plans.push(v);
    return Promise.resolve();
  }
  sendPackage(v: PackageView) {
    this.packages.push(v);
    return Promise.resolve();
  }
  sendExport(v: ExportView) {
    this.exports.push(v);
    return Promise.resolve();
  }
}

/**
 * Test fixture: there are no built-in agents, so tests create their team themselves. The ids
 * are the fixture's own (the ones the old seed used, so scenario tests read the same), the
 * definitions and prompts come from the library templates (config/library).
 */
export const TEST_TEAM: { id: string; template: string; status?: 'active' | 'draft' }[] = [
  { id: 'ceo', template: 'planner' },
  { id: 'copywriter', template: 'copywriter' },
  { id: 'critic', template: 'reviewer' },
  { id: 'seo', template: 'seo', status: 'draft' },
  { id: 'image', template: 'image' },
  { id: 'kp', template: 'kp' },
  { id: 'stt_voice', template: 'stt_voice' },
  { id: 'video_transcribe', template: 'video_transcribe' },
  { id: 'kp_render', template: 'kp_render' },
  { id: 'mailer_send', template: 'mailer_send' },
];

const COLORS = ['violet', 'indigo', 'cyan', 'emerald', 'pink', 'amber', 'blue'];

export async function seedTestTeam(
  db: Db,
  brandId: string,
  opts: { only?: string[]; links?: boolean } = {},
): Promise<void> {
  await loadWorkspace(db, brandId); // «Бриф» and «Вы»
  const lib = loadLibraryFiles();
  const team = TEST_TEAM.filter((m) => !opts.only || opts.only.includes(m.id));
  const actor = { kind: 'system', id: 'test:fixture' } as const;
  for (const [i, m] of team.entries()) {
    const t = lib.find((x) => x.slug === m.template)!;
    await db
      .insert(schema.agentDefinitions)
      .values({
        brandId,
        id: m.id,
        name: t.name,
        role: t.role,
        description: t.description,
        kind: 'custom',
        status: m.status ?? 'active',
        teamRole: t.teamRole,
        capability: t.capability,
        color: COLORS[i % COLORS.length]!,
        icon: [...t.name][0]!.toUpperCase(),
        modelRole: t.capability && !t.prompt ? null : (t.modelRole ?? 'worker'),
        spec: { fields: t.fields, criteria: t.criteria, lastTest: null },
        createdBy: actor.id,
      })
      .onConflictDoNothing();
    await placeNewNode(db, brandId, m.id);
    if (t.prompt) await savePromptVersion(db, brandId, m.id, t.prompt, actor);
  }
  if (opts.links === false) return;
  const ids = new Set(team.map((m) => m.id));
  for (const [from, to] of [
    [BRIEF, 'ceo'],
    ['ceo', 'copywriter'],
    ['copywriter', 'critic'],
    ['critic', OWNER],
  ] as const)
    if ((ids.has(from) || from === BRIEF) && (ids.has(to) || to === OWNER))
      await db
        .insert(schema.agentLinks)
        .values({ brandId, fromNode: from, toNode: to, kind: 'user', createdBy: actor.id })
        .onConflictDoNothing();
}

/**
 * Test helper (instead of the old presets): agents from library templates — created (or the
 * fixture's draft reused), tested on the mock model and switched on, like the owner would.
 * Returns the ids switched on now.
 */
export async function addTemplatesForTest(
  deps: AgentTestDeps,
  brandId: string,
  slugs: readonly string[] = ['seo', 'reels', 'video_summary', 'mailer_draft'],
): Promise<string[]> {
  await syncLibrary(deps.db, brandId);
  const actor = { kind: 'human', id: 'test:owner' } as const;
  const out: string[] = [];
  for (const slug of slugs) {
    let ref = await resolveAgent(deps.db, brandId, slug);
    if (!ref) {
      const r = await addFromTemplate(deps.db, brandId, slug, actor);
      if (!r.ok) throw new Error(`${slug}: ${r.message}`);
      ref = await resolveAgent(deps.db, brandId, r.id!);
    }
    if (!ref || ref.status === 'active') continue;
    const test = await runAgentTest(deps, brandId, ref.id, {}, actor);
    if (!test.ok) throw new Error(`${slug}: ${test.message}`);
    const on = await activateConstructorAgent(deps.db, brandId, ref.id, actor, () =>
      Promise.resolve(),
    );
    if (!on.ok) throw new Error(`${slug}: ${on.message}`);
    out.push(ref.id);
  }
  return out.sort();
}
