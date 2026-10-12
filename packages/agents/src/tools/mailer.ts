import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import { PermanentError, type Actor, type AppConfig, type Logger } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import {
  createRun,
  createTask,
  finalizeCost,
  reserveCost,
  withIdempotency,
  type BudgetContext,
  type Run,
} from '@cms/engine';
import type { MailSender } from '@cms/providers';
import type { NodeContent } from '../nodes.js';

const { contacts, suppressions, campaigns, campaignSends, artifacts, approvals, auditLog } = schema;

export const MAILING_TASK_KIND = 'mailing';
/** The only merge fields an email may use. */
export const MERGE_FIELDS = ['name', 'unsubscribe_url'] as const;

export interface MailerDeps {
  db: Db;
  config: AppConfig;
  sender: MailSender;
  budget: BudgetContext;
  logger: Logger;
}

export interface MailResult {
  ok: boolean;
  message: string;
  id?: string;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const emailHash = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

const audit = (db: Db, brandId: string, actor: Actor, action: string, details: object) =>
  db
    .insert(auditLog)
    .values({ brandId, actorKind: actor.kind, actorId: actor.id, action, details });

// ------------------------------------------------------------------ contacts

/**
 * CSV import: email, name, consent_at, consent_source. A contact without consent date and
 * source is stored but never receives anything. Addresses are not logged: only counts.
 */
export async function importContacts(
  db: Db,
  brandId: string,
  csv: string,
  actor: Actor,
): Promise<MailResult & { added?: number; withConsent?: number; rejected?: number }> {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv<Record<string, string>>(csv.replace(/^\uFEFF/, ''), {
      columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      delimiter: [',', ';'],
    });
  } catch {
    return {
      ok: false,
      message: 'Не удалось прочитать CSV: нужны колонки email, name, consent_at, consent_source',
    };
  }
  if (!rows.length || !('email' in rows[0]!))
    return { ok: false, message: 'В CSV нет колонки email' };
  let added = 0;
  let withConsent = 0;
  let rejected = 0;
  for (const r of rows.slice(0, 50_000)) {
    const email = (r.email ?? '').toLowerCase();
    if (!EMAIL.test(email)) {
      rejected++;
      continue;
    }
    const consentAt = r.consent_at ? new Date(r.consent_at) : null;
    const hasConsent = !!consentAt && !Number.isNaN(consentAt.getTime()) && !!r.consent_source;
    if (hasConsent) withConsent++;
    await db
      .insert(contacts)
      .values({
        brandId,
        email,
        fields: r.name ? { name: r.name.slice(0, 100) } : {},
        consentAt: hasConsent ? consentAt : null,
        consentSource: hasConsent ? r.consent_source!.slice(0, 200) : null,
      })
      .onConflictDoUpdate({
        target: [contacts.brandId, contacts.email],
        set: {
          fields: r.name ? { name: r.name.slice(0, 100) } : {},
          consentAt: hasConsent ? consentAt : null,
          consentSource: hasConsent ? r.consent_source!.slice(0, 200) : null,
          updatedAt: sql`now()`,
        },
      });
    added++;
  }
  await audit(db, brandId, actor, 'contacts_imported', { rows: added, withConsent, rejected });
  return {
    ok: true,
    added,
    withConsent,
    rejected,
    message: `Загружено ${added}, с согласием ${withConsent}${rejected ? `, отклонено ${rejected} (неверный адрес)` : ''}`,
  };
}

/** Contacts that may receive the mailing now: consent stored, not unsubscribed, not suppressed. */
async function eligible(db: Db, brandId: string) {
  return db
    .select({ id: contacts.id, email: contacts.email, fields: contacts.fields })
    .from(contacts)
    .where(
      sql`${contacts.brandId} = ${brandId} and ${contacts.consentAt} is not null and ${contacts.consentSource} is not null and ${contacts.unsubscribedAt} is null
        and encode(sha256(lower(${contacts.email})::bytea), 'hex') not in (select ${suppressions.emailHash} from ${suppressions} where ${suppressions.brandId} = ${brandId})`,
    )
    .orderBy(contacts.id);
}

export async function audienceStats(db: Db, brandId: string) {
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      consent: sql<number>`count(*) filter (where ${contacts.consentAt} is not null and ${contacts.consentSource} is not null)::int`,
      unsubscribed: sql<number>`count(*) filter (where ${contacts.unsubscribedAt} is not null)::int`,
    })
    .from(contacts)
    .where(sql`${contacts.brandId} = ${brandId}`);
  const [sup] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(sql`${suppressions.brandId} = ${brandId}`);
  return {
    total: r?.total ?? 0,
    withConsent: r?.consent ?? 0,
    withoutConsent: (r?.total ?? 0) - (r?.consent ?? 0),
    unsubscribed: r?.unsubscribed ?? 0,
    suppressed: sup?.n ?? 0,
    eligible: (await eligible(db, brandId)).length,
  };
}

/** Unsubscribe / complaint / bounce: the address is never mailed again (only its hash is kept). */
export async function suppress(
  db: Db,
  brandId: string,
  email: string,
  reason: 'unsubscribe' | 'complaint' | 'bounce' | 'manual',
) {
  await db
    .insert(suppressions)
    .values({ brandId, emailHash: emailHash(email), reason })
    .onConflictDoNothing();
  await db
    .update(contacts)
    .set({ unsubscribedAt: sql`now()` })
    .where(sql`${contacts.brandId} = ${brandId} and ${contacts.email} = ${email.toLowerCase()}`);
}

// ------------------------------------------------------------------ campaign

const listHash = (ids: string[]) =>
  createHash('sha256')
    .update([...ids].sort().join(','))
    .digest('hex')
    .slice(0, 16);

/** Merge fields used in a text that are not allowed (e.g. {{city}}). */
export function unknownMergeFields(text: string): string[] {
  const used = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(used.filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f)))];
}

/** A campaign from an APPROVED «Письмо» result (gate 2 passed). */
export async function createCampaign(
  db: Db,
  brandId: string,
  artifactId: string,
  actor: Actor,
): Promise<MailResult> {
  const [a] = await db
    .select()
    .from(artifacts)
    .where(sql`${artifacts.id} = ${artifactId} and ${artifacts.brandId} = ${brandId}`);
  if (!a || !a.slot.startsWith('node:mailer_draft:'))
    return { ok: false, message: 'Это не результат агента «Письмо»' };
  const [ok] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      sql`${approvals.artifactId} = ${artifactId} and ${approvals.gate} = 'final' and ${approvals.decision} = 'approved'`,
    );
  if (!ok) return { ok: false, message: 'Сначала утвердите письмо в «Согласовании»' };
  const o = (a.content as NodeContent).output as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const subject = str(o.subject);
  const bodyText = str(o.body_text);
  const bodyHtml = str(o.body_html);
  if (!subject || !bodyText) return { ok: false, message: 'В письме нет темы или текста' };
  const bad = unknownMergeFields(`${subject}\n${bodyText}\n${bodyHtml}`);
  if (bad.length)
    return {
      ok: false,
      message: `Неизвестные поля подстановки: ${bad.map((b) => `{{${b}}}`).join(', ')}`,
    };
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(bodyText))
    return { ok: false, message: 'В тексте письма нет ссылки отписки {{unsubscribe_url}}' };
  const [c] = await db
    .insert(campaigns)
    .values({
      brandId,
      artifactId,
      title: subject.slice(0, 120),
      subject,
      bodyText,
      bodyHtml: bodyHtml || `<p>${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p>`,
      createdBy: actor.id,
    })
    .returning({ id: campaigns.id });
  await audit(db, brandId, actor, 'campaign_created', { campaignId: c!.id, artifactId });
  return { ok: true, id: c!.id, message: 'Рассылка создана: отправьте тестовое письмо себе' };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function unsubscribeUrl(config: AppConfig, campaignId: string, contactId: string) {
  const base = config.mail.unsubscribeUrl ?? 'https://example.invalid/unsubscribe';
  const token = createHash('sha256')
    .update(`${campaignId}:${contactId}`)
    .digest('hex')
    .slice(0, 24);
  return `${base}${base.includes('?') ? '&' : '?'}c=${contactId}&t=${token}`;
}

function personalize(
  config: AppConfig,
  c: { id: string; subject: string; bodyText: string; bodyHtml: string },
  contact: { id: string; email: string; fields: unknown },
) {
  const name = String((contact.fields as { name?: string }).name ?? '');
  const unsub = unsubscribeUrl(config, c.id, contact.id);
  const fill = (s: string, html: boolean) =>
    s
      .replace(/\{\{\s*name\s*\}\}/g, html ? escapeHtml(name) : name)
      .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsub);
  return {
    to: contact.email,
    from: config.mail.from ?? 'mock@example.invalid',
    subject: fill(c.subject, false),
    text: fill(c.bodyText, false),
    html: fill(c.bodyHtml, true),
    // RFC 8058 one-click unsubscribe.
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

async function campaign(db: Db, id: string) {
  const [c] = await db
    .select()
    .from(campaigns)
    .where(sql`${campaigns.id} = ${id}`);
  if (!c) throw new PermanentError('campaign_not_found', 'Рассылка не найдена');
  return c;
}

/** Step 1 of sending: a test email to the owner (MAIL_TEST_TO). */
export async function sendTestEmail(
  d: MailerDeps,
  campaignId: string,
  actor: Actor,
): Promise<MailResult> {
  const c = await campaign(d.db, campaignId);
  if (!['draft', 'tested'].includes(c.status))
    return { ok: false, message: 'Тест уже не нужен: рассылка подтверждена' };
  if (!d.config.mail.testTo && d.sender.name !== 'mock')
    return { ok: false, message: 'Укажите MAIL_TEST_TO в .env — туда придёт тестовое письмо' };
  const to = d.config.mail.testTo ?? 'owner@example.invalid';
  const msg = personalize(d.config, c, { id: 'test', email: to, fields: { name: 'Тест' } });
  await d.sender.send({ ...msg, subject: `[ТЕСТ] ${msg.subject}` });
  await d.db
    .update(campaigns)
    .set({ status: 'tested', testSentAt: sql`now()`, updatedAt: sql`now()` })
    .where(sql`${campaigns.id} = ${campaignId}`);
  await audit(d.db, c.brandId, actor, 'campaign_test_sent', {
    campaignId,
    provider: d.sender.name,
  });
  return {
    ok: true,
    message:
      d.sender.name === 'mock'
        ? 'Тестовое письмо «отправлено» (mock: никуда не ушло). Проверьте текст и подтвердите отправку'
        : 'Тестовое письмо отправлено вам. Проверьте его и подтвердите отправку',
  };
}

/**
 * Step 2: the owner's explicit "Отправить N адресам". N must equal the current eligible list
 * (the list did not change since the owner looked). Only a human may confirm. Creates one send
 * row per (campaign, contact) and queues the sending run.
 */
export async function confirmCampaign(
  d: MailerDeps & { enqueue: (runId: string) => Promise<unknown> },
  campaignId: string,
  recipients: number,
  actor: Actor,
): Promise<MailResult> {
  if (actor.kind !== 'human')
    return { ok: false, message: 'Подтвердить отправку может только человек' };
  const c = await campaign(d.db, campaignId);
  if (c.status !== 'tested')
    return {
      ok: false,
      message:
        c.status === 'draft'
          ? 'Сначала отправьте тестовое письмо себе'
          : 'Рассылка уже подтверждена',
    };
  const list = await eligible(d.db, c.brandId);
  if (list.length === 0) return { ok: false, message: 'Нет адресов с согласием на рассылку' };
  if (list.length !== recipients)
    return {
      ok: false,
      message: `Список изменился: сейчас ${list.length} адресов. Проверьте и подтвердите снова`,
    };
  const sentToday = await sentTodayCount(d.db, c.brandId, d.config.timezone);
  if (sentToday + list.length > d.config.mail.maxPerDay)
    return {
      ok: false,
      message: `Превышен суточный лимит MAIL_MAX_PER_DAY (${d.config.mail.maxPerDay}): сегодня уже ${sentToday}`,
    };
  const hash = listHash(list.map((x) => x.id));
  const { id: taskId } = await createTask(d.db, {
    brandId: c.brandId,
    kind: MAILING_TASK_KIND,
    title: `Рассылка: ${c.title}`,
    brief: { text: `Рассылка ${c.title}`, campaignId },
    budgetUsd: d.config.budget.taskUsd,
    actor,
  });
  await d.db.transaction(async (tx) => {
    await tx
      .update(campaigns)
      .set({
        status: 'confirmed',
        recipients: list.length,
        listHash: hash,
        confirmedBy: actor.id,
        confirmedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(sql`${campaigns.id} = ${campaignId} and ${campaigns.status} = 'tested'`);
    for (let i = 0; i < list.length; i += 500)
      await tx
        .insert(campaignSends)
        .values(list.slice(i, i + 500).map((x) => ({ campaignId, contactId: x.id })))
        .onConflictDoNothing();
  });
  // Addresses never go to logs or audit: only the count and the hash of the list.
  await audit(d.db, c.brandId, actor, 'campaign_confirmed', {
    campaignId,
    recipients: list.length,
    listHash: hash,
  });
  const { run } = await createRun(d.db, {
    brandId: c.brandId,
    taskId,
    agent: 'mailer_send',
    idempotencyKey: `mail-send:${campaignId}`,
    input: { kind: 'mail_send', campaignId },
  });
  await d.enqueue(run.id);
  return { ok: true, message: `Отправка ${list.length} адресам началась` };
}

/** «Остановить рассылку»: unsent letters become «остановлено». */
export async function stopCampaign(db: Db, campaignId: string, actor: Actor): Promise<MailResult> {
  const c = await campaign(db, campaignId);
  if (!['confirmed', 'sending'].includes(c.status))
    return { ok: false, message: 'Рассылка не идёт' };
  await db
    .update(campaigns)
    .set({ status: 'stopping', updatedAt: sql`now()` })
    .where(sql`${campaigns.id} = ${campaignId}`);
  await db
    .update(campaignSends)
    .set({ status: 'stopped' })
    .where(sql`${campaignSends.campaignId} = ${campaignId} and ${campaignSends.status} = 'queued'`);
  await audit(db, c.brandId, actor, 'campaign_stopped', { campaignId });
  return { ok: true, message: 'Рассылка остановлена: неотправленные письма не уйдут' };
}

async function sentTodayCount(db: Db, brandId: string, tz: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSends)
    .innerJoin(campaigns, sql`${campaigns.id} = ${campaignSends.campaignId}`)
    .where(
      sql`${campaigns.brandId} = ${brandId} and ${campaignSends.status} = 'sent' and (${campaignSends.sentAt} at time zone ${tz})::date = (now() at time zone ${tz})::date`,
    );
  return r?.n ?? 0;
}

export async function campaignReport(db: Db, campaignId: string) {
  const rows = await db
    .select({ status: campaignSends.status, n: sql<number>`count(*)::int` })
    .from(campaignSends)
    .where(sql`${campaignSends.campaignId} = ${campaignId}`)
    .groupBy(campaignSends.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  return {
    queued: by.queued ?? 0,
    sent: by.sent ?? 0,
    failed: by.failed ?? 0,
    stopped: by.stopped ?? 0,
    suppressed: by.suppressed ?? 0,
  };
}

/**
 * The sending run (queue worker): batches of MAIL_BATCH_SIZE with a pause; every letter once
 * per (campaign, contact) — a redelivered job does not send twice; stops on «Остановить».
 */
export async function runCampaign(d: MailerDeps, run: Run, signal: AbortSignal) {
  const campaignId = (run.input as { campaignId: string }).campaignId;
  let c = await campaign(d.db, campaignId);
  if (['done', 'stopped'].includes(c.status)) return campaignReport(d.db, campaignId);
  await d.db
    .update(campaigns)
    .set({ status: 'sending', updatedAt: sql`now()` })
    .where(sql`${campaigns.id} = ${campaignId} and ${campaigns.status} = 'confirmed'`);
  for (;;) {
    c = await campaign(d.db, campaignId);
    if (c.status === 'stopping') {
      await d.db
        .update(campaigns)
        .set({ status: 'stopped', updatedAt: sql`now()` })
        .where(sql`${campaigns.id} = ${campaignId}`);
      break;
    }
    const batch = await d.db
      .select({ send: campaignSends, contact: contacts })
      .from(campaignSends)
      .innerJoin(contacts, sql`${contacts.id} = ${campaignSends.contactId}`)
      .where(
        sql`${campaignSends.campaignId} = ${campaignId} and ${campaignSends.status} = 'queued'`,
      )
      .orderBy(campaignSends.createdAt, campaignSends.id)
      .limit(d.config.mail.batchSize);
    if (batch.length === 0) {
      await d.db
        .update(campaigns)
        .set({ status: 'done', updatedAt: sql`now()` })
        .where(sql`${campaigns.id} = ${campaignId} and ${campaigns.status} = 'sending'`);
      break;
    }
    for (const { send, contact } of batch) {
      // Consent or unsubscribe may have changed since the confirmation.
      const [blocked] = await d.db
        .select({ h: suppressions.emailHash })
        .from(suppressions)
        .where(
          sql`${suppressions.brandId} = ${c.brandId} and ${suppressions.emailHash} = ${emailHash(contact.email)}`,
        );
      if (blocked || contact.unsubscribedAt || !contact.consentAt) {
        await d.db
          .update(campaignSends)
          .set({ status: 'suppressed' })
          .where(sql`${campaignSends.id} = ${send.id}`);
        continue;
      }
      try {
        const { result } = await withIdempotency(
          d.db,
          `mail:${campaignId}:${contact.id}`,
          async () => {
            const reservation = await reserveCost(d.db, d.budget, {
              brandId: c.brandId,
              taskId: run.taskId,
              runId: run.id,
              agent: 'mailer_send',
              kind: 'email',
              provider: d.sender.name,
              model: 'email',
              estimateUsd: 0, // TODO(verify): price per letter of the chosen mail service
              idempotencyKey: `mail-cost:${campaignId}:${contact.id}`,
            });
            const r = await d.sender.send(personalize(d.config, c, contact));
            await finalizeCost(d.db, reservation.id, {
              costUsd: 0,
              model: 'email',
              estimated: false,
              units: 1,
            });
            return r;
          },
        );
        await d.db
          .update(campaignSends)
          .set({ status: 'sent', providerMessageId: result.messageId, sentAt: sql`now()` })
          .where(sql`${campaignSends.id} = ${send.id}`);
      } catch (err) {
        await d.db
          .update(campaignSends)
          .set({
            status: 'failed',
            error: err instanceof Error ? err.message.slice(0, 300) : 'error',
          })
          .where(sql`${campaignSends.id} = ${send.id}`);
      }
    }
    if (d.config.mail.batchPauseSeconds > 0)
      await sleep(d.config.mail.batchPauseSeconds * 1000, undefined, { signal });
  }
  const report = await campaignReport(d.db, campaignId);
  d.logger.info({ campaignId, ...report }, 'campaign finished');
  return report;
}
