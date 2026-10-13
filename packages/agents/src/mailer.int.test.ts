import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import { LlmClient, processRun } from '@cms/engine';
import {
  budgetCtx,
  llmConfig,
  pricing,
  setupTestDb,
  silentLogger,
  type TestDb,
} from '@cms/engine/testkit';
import { MockMailSender } from '@cms/providers';
import { BrandProfile, upsertBrand } from './brand.js';
import { MockLlmTransport } from './mock-llm.js';
import { RecordingChannel, seedTestTeam, addTemplatesForTest } from './testing.js';
import {
  audienceStats,
  createCampaign,
  importContacts,
  stopCampaign,
  suppress,
  unknownMergeFields,
} from './tools/mailer.js';
import { Workflow } from './workflow.js';
import { addLink } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;
const CSV = [
  'email,name,consent_at,consent_source',
  'anna@example.com,Анна,2026-09-01,форма на сайте',
  'boris@example.com,Борис,2026-09-02,кофейня: подписной лист',
  'no-consent@example.com,Без согласия,,',
  'not-an-email,Кто-то,2026-09-01,форма',
  'gone@example.com,Ушёл,2026-09-01,форма',
].join('\n');

describe('mailing (mock): consent, test email, explicit N, batches, idempotency, stop', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  async function setup() {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: `mail-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    await seedTestTeam(t.db, brand.id);
    const channel = new RecordingChannel();
    const queue: string[] = [];
    const sender = new MockMailSender();
    const config = {
      ...t.config,
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      llm: llmConfig(),
      mail: { ...t.config.mail, batchSize: 1, batchPauseSeconds: 0 },
    };
    const llm = new LlmClient({
      db: t.db,
      transport: new MockLlmTransport(),
      pricing: pricing(),
      config: llmConfig(),
      budget: budgetCtx(),
      notifier: channel,
      logger: silentLogger,
    });
    const wf = new Workflow({
      db: t.db,
      llm,
      channel,
      enqueue: (id) => Promise.resolve(queue.push(id)),
      config,
      pricing: pricing(),
      logger: silentLogger,
      mail: sender,
    });
    const deps = {
      db: t.db,
      notifier: channel,
      logger: silentLogger,
      staleAfterSeconds: 60,
      gate: wf.gate,
    };
    const drain = async () => {
      while (queue.length)
        await processRun(deps, queue.shift()!, wf.handleRun, new AbortController().signal);
    };
    // A «Письмо» result from a normal task (mock text has {{name}} and {{unsubscribe_url}}).
    await addTemplatesForTest(
      { db: t.db, config, controls: wf.controls, logger: silentLogger },
      brand.id,
    );
    expect((await addLink(t.db, brand.id, 'ceo', 'mailer_draft', OWNER)).ok).toBe(true);
    const { taskId } = await wf.submitBrief(brand.id, 'Письмо подписчикам про осеннее меню', OWNER);
    await drain();
    await wf.decidePlan(taskId, 'approve', OWNER);
    await drain();
    const item = channel.packages.at(-1)!.nodeItems.find((n) => n.agent === 'mailer_draft')!;
    return { brand, channel, wf, drain, sender, item, config };
  }

  it('full path with every gate, then no double sending', async () => {
    const s = await setup();
    // Not approved yet -> no campaign.
    expect((await createCampaign(t.db, s.brand.id, s.item.artifactId, OWNER)).message).toMatch(
      /утвердите/,
    );
    expect((await s.wf.decideArtifact(s.item.artifactId, 'approve', OWNER)).ok).toBe(true);
    const camp = await createCampaign(t.db, s.brand.id, s.item.artifactId, OWNER);
    expect(camp.ok, camp.message).toBe(true);

    const imp = await importContacts(t.db, s.brand.id, CSV, OWNER);
    expect(imp).toMatchObject({ ok: true, added: 4, withConsent: 3, rejected: 1 });
    await suppress(t.db, s.brand.id, 'gone@example.com', 'unsubscribe');
    expect(await audienceStats(t.db, s.brand.id)).toMatchObject({
      total: 4,
      withConsent: 3,
      eligible: 2,
    });

    // No confirmation before the test email; agents cannot confirm; N must match.
    expect((await s.wf.confirmCampaign(camp.id!, 2, OWNER)).message).toMatch(/тестовое/);
    expect((await s.wf.sendTestEmail(camp.id!, OWNER)).ok).toBe(true);
    expect(s.sender.sent).toHaveLength(1);
    expect(s.sender.sent[0]!.subject).toMatch(/^\[ТЕСТ\]/);
    expect((await s.wf.confirmCampaign(camp.id!, 2, { kind: 'agent', id: 'ceo' })).ok).toBe(false);
    expect((await s.wf.confirmCampaign(camp.id!, 5, OWNER)).message).toMatch(/сейчас 2/);
    expect(s.sender.sent).toHaveLength(1);

    const go = await s.wf.confirmCampaign(camp.id!, 2, OWNER);
    expect(go.ok, go.message).toBe(true);
    await s.drain();
    const real = s.sender.sent.slice(1);
    expect(real.map((m) => m.to).sort()).toEqual(['anna@example.com', 'boris@example.com']);
    expect(real[0]!.text).toMatch(/Привет, (Анна|Борис)!/);
    expect(real[0]!.text).not.toMatch(/\{\{/);
    expect(real[0]!.headers['List-Unsubscribe']).toMatch(/^<https:/);
    expect(real[0]!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(s.channel.messages.at(-1)!.text).toMatch(/отправлено 2/);

    // A redelivered job / second run sends nothing again.
    await t.db
      .update(schema.campaignSends)
      .set({ status: 'queued' })
      .where(sql`${schema.campaignSends.campaignId} = ${camp.id!}`);
    await t.db
      .update(schema.campaigns)
      .set({ status: 'sending' })
      .where(sql`${schema.campaigns.id} = ${camp.id!}`);
    const [run] = await t.db
      .select()
      .from(schema.runs)
      .where(sql`${schema.runs.idempotencyKey} = ${`mail-send:${camp.id!}`}`);
    await t.db
      .update(schema.runs)
      .set({ status: 'queued' })
      .where(sql`${schema.runs.id} = ${run!.id}`);
    await processRun(
      {
        db: t.db,
        notifier: s.channel,
        logger: silentLogger,
        staleAfterSeconds: 60,
        gate: s.wf.gate,
      },
      run!.id,
      s.wf.handleRun,
      new AbortController().signal,
    );
    expect(s.sender.sent).toHaveLength(3);

    // Audit: counts and a hash, never the addresses.
    const audit = await t.db
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.brandId} = ${s.brand.id}`);
    const dump = JSON.stringify(audit);
    expect(dump).not.toMatch(/@example\.com/);
    expect(dump).toMatch(/"recipients":2/);
  });

  it('stop: unsent letters stay unsent; merge fields are checked', async () => {
    const s = await setup();
    await s.wf.decideArtifact(s.item.artifactId, 'approve', OWNER);
    const camp = await createCampaign(t.db, s.brand.id, s.item.artifactId, OWNER);
    await importContacts(t.db, s.brand.id, CSV, OWNER);
    await s.wf.sendTestEmail(camp.id!, OWNER);
    expect((await s.wf.confirmCampaign(camp.id!, 3, OWNER)).ok).toBe(true);
    expect((await stopCampaign(t.db, camp.id!, OWNER)).ok).toBe(true);
    await s.drain();
    expect(s.sender.sent).toHaveLength(1); // only the test
    const [c] = await t.db
      .select()
      .from(schema.campaigns)
      .where(sql`${schema.campaigns.id} = ${camp.id!}`);
    expect(c!.status).toBe('stopped');
    expect(unknownMergeFields('Привет, {{name}} из {{city}} {{ unsubscribe_url }}')).toEqual([
      'city',
    ]);
  });
});
