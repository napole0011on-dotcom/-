import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { errorToJson, type Actor, type AppConfig, type Logger } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import {
  TOOLS,
  audienceStats,
  campaignReport,
  createCampaign,
  importContacts,
  stopCampaign,
  type Workflow,
} from '@cms/agents';
import type { ObjectStorage, SttSegment } from '@cms/providers';
import type { Mirror } from './routes.js';

const { transcripts, mediaFiles, runs, campaigns, artifacts, approvals, tasks } = schema;

const ACTOR: Actor = { kind: 'human', id: 'panel:owner' };
const uuid = z.uuid();
const OUTPUT_NAMES = ['transcript.txt', 'subtitles.srt', 'subtitles.vtt', 'transcript.json'];
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'm4v']);

export interface MediaRoutesDeps {
  db: Db;
  config: AppConfig;
  workflow: Workflow;
  brandId: () => string;
  storage?: ObjectStorage;
  mirror: Mirror;
  logger: Logger;
}

/** «Расшифровки» and «Рассылка» pages. Mutations go through the panel preHandler (Origin, session, CSRF). */
export async function registerMediaRoutes(app: FastifyInstance, d: MediaRoutesDeps) {
  const maxBytes = Math.max(d.config.media.voiceMaxBytes, d.config.media.videoMaxBytes);
  await app.register(multipart, { limits: { fileSize: maxBytes, files: 1, fields: 4 } });
  const brand = () => d.brandId();

  async function reply409(reply: FastifyReply, r: { ok: boolean; message: string }, mirror = true) {
    if (r.ok && mirror)
      await d.mirror.notify(`🖥 В панели: ${r.message}`).catch((err: unknown) => {
        d.logger.warn({ err: errorToJson(err) }, 'telegram mirror failed');
      });
    return reply.code(r.ok ? 200 : 409).send(r);
  }

  // ------------------------------------------------------------------ transcripts

  app.get('/api/transcripts', async () => {
    const rows = await d.db
      .select({ t: transcripts, f: mediaFiles, progress: runs.progress })
      .from(transcripts)
      .innerJoin(mediaFiles, sql`${mediaFiles.id} = ${transcripts.fileId}`)
      .leftJoin(runs, sql`${runs.taskId} = ${transcripts.taskId}`)
      .where(sql`${transcripts.brandId} = ${brand()}`)
      .orderBy(sql`${transcripts.createdAt} desc`)
      .limit(200);
    return rows.map(({ t, f, progress }) => ({
      id: t.id,
      name: f.originalName,
      kind: f.kind,
      source: f.source,
      status: t.status,
      progress:
        t.status === 'done'
          ? 100
          : (progress ?? (t.chunksTotal ? Math.round((t.chunksDone / t.chunksTotal) * 100) : 0)),
      durationSec: t.durationSec === null ? null : Number(t.durationSec),
      preview: t.text.slice(0, 160),
      error: t.error,
      createdAt: t.createdAt,
    }));
  });

  app.get<{ Params: { id: string } }>('/api/transcripts/:id', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    const [row] = await d.db
      .select({ t: transcripts, f: mediaFiles })
      .from(transcripts)
      .innerJoin(mediaFiles, sql`${mediaFiles.id} = ${transcripts.fileId}`)
      .where(sql`${transcripts.id} = ${req.params.id} and ${transcripts.brandId} = ${brand()}`);
    if (!row) return reply.code(404).send({ error: 'Расшифровка не найдена' });
    const { t, f } = row;
    return {
      id: t.id,
      name: f.originalName,
      kind: f.kind,
      status: t.status,
      error: t.error,
      language: t.language,
      provider: t.provider,
      model: t.model,
      durationSec: t.durationSec === null ? null : Number(t.durationSec),
      chunksDone: t.chunksDone,
      chunksTotal: t.chunksTotal,
      segments: t.segments as SttSegment[],
      files: (t.files as { name: string }[]).map((x) => x.name),
      mediaAvailable: !f.deletedAt,
      mediaExpiresAt: f.expiresAt,
      mimeType: f.mimeType,
      createdAt: t.createdAt,
    };
  });

  /** TXT / SRT / VTT / JSON downloads (only the four names the pipeline writes). */
  app.get<{ Params: { id: string; name: string } }>(
    '/api/transcripts/:id/files/:name',
    async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success || !OUTPUT_NAMES.includes(req.params.name))
        return reply.code(400).send({ error: 'Неверный запрос' });
      const [t] = await d.db
        .select()
        .from(transcripts)
        .where(sql`${transcripts.id} = ${req.params.id} and ${transcripts.brandId} = ${brand()}`);
      const f = (t?.files as { name: string; key: string; mimeType: string }[] | undefined)?.find(
        (x) => x.name === req.params.name,
      );
      if (!f || !d.storage) return reply.code(404).send({ error: 'Файл не найден' });
      return reply
        .header('Content-Type', f.mimeType)
        .header('Content-Disposition', `attachment; filename="${f.name}"`)
        .send(await d.storage.get(f.key));
    },
  );

  /** The audio/video itself for the player; Range requests so the owner can jump to a timecode. */
  app.get<{ Params: { id: string } }>('/api/transcripts/:id/media', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    const [row] = await d.db
      .select({ f: mediaFiles })
      .from(transcripts)
      .innerJoin(mediaFiles, sql`${mediaFiles.id} = ${transcripts.fileId}`)
      .where(sql`${transcripts.id} = ${req.params.id} and ${transcripts.brandId} = ${brand()}`);
    if (!row || row.f.deletedAt || !d.storage)
      return reply.code(404).send({ error: 'Файл уже удалён (срок хранения истёк)' });
    const body = await d.storage.get(row.f.storageKey);
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', row.f.mimeType);
    if (!m) return reply.send(body);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (start > end || start >= body.length)
      return reply.code(416).header('Content-Range', `bytes */${body.length}`).send();
    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${body.length}`)
      .send(body.subarray(start, end + 1));
  });

  app.post('/api/transcripts/upload', async (req, reply) => {
    let file;
    try {
      file = await req.file();
    } catch {
      return reply.code(400).send({ ok: false, message: 'Нужен файл' });
    }
    if (!file) return reply.code(400).send({ ok: false, message: 'Нужен файл' });
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      return reply.code(413).send({
        ok: false,
        message: `Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`,
      });
    }
    const ext = path.extname(file.filename).slice(1).toLowerCase();
    const kind = VIDEO_EXT.has(ext) || file.mimetype.startsWith('video/') ? 'video' : 'voice';
    const r = await d.workflow.transcribeUpload(
      brand(),
      { kind, source: 'panel', name: file.filename, mimeType: file.mimetype, data },
      ACTOR,
    );
    return reply.code(r.ok ? 200 : 409).send(r);
  });

  app.post<{ Params: { id: string } }>('/api/transcripts/:id/cancel', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    return reply409(reply, await d.workflow.cancelTranscript(req.params.id, ACTOR), false);
  });

  /** «Передать в задачу» / «В Reels»: a new content task with the transcript attached. */
  app.post<{ Params: { id: string } }>('/api/transcripts/:id/task', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    const body = z
      .object({ text: z.string().max(8000).nullable().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ ok: false, message: 'Неверный запрос' });
    const text = body.data.text?.trim();
    if (text && text.length < 10)
      return reply.code(400).send({ ok: false, message: 'Бриф слишком короткий' });
    return reply409(reply, await d.workflow.createTaskFromTranscript(req.params.id, ACTOR, text));
  });

  // ------------------------------------------------------------------ mailing

  app.get('/api/mailing', async () => {
    const list = await d.db
      .select()
      .from(campaigns)
      .where(sql`${campaigns.brandId} = ${brand()}`)
      .orderBy(sql`${campaigns.createdAt} desc`)
      .limit(50);
    const used = new Set(list.map((c) => c.artifactId));
    // Approved «Письмо» results that can become a mailing.
    const drafts = await d.db
      .select({
        id: artifacts.id,
        content: artifacts.content,
        createdAt: artifacts.createdAt,
        task: tasks.title,
      })
      .from(artifacts)
      .innerJoin(
        approvals,
        sql`${approvals.artifactId} = ${artifacts.id} and ${approvals.gate} = 'final' and ${approvals.decision} = 'approved'`,
      )
      .innerJoin(tasks, sql`${tasks.id} = ${artifacts.taskId}`)
      .where(
        sql`${artifacts.brandId} = ${brand()} and ${artifacts.slot} like 'node:mailer_draft:%'`,
      )
      .orderBy(sql`${artifacts.createdAt} desc`)
      .limit(50);
    return {
      provider: d.config.mail.provider,
      testTo: !!d.config.mail.testTo,
      unsubscribeUrl: !!d.config.mail.unsubscribeUrl,
      limits: {
        batchSize: d.config.mail.batchSize,
        batchPauseSeconds: d.config.mail.batchPauseSeconds,
        maxPerDay: d.config.mail.maxPerDay,
      },
      audience: await audienceStats(d.db, brand()),
      drafts: drafts
        .filter((x) => !used.has(x.id))
        .map((x) => {
          const o = (x.content as { output?: Record<string, unknown> }).output ?? {};
          return {
            artifactId: x.id,
            task: x.task,
            subject: typeof o.subject === 'string' ? o.subject : '',
            createdAt: x.createdAt,
          };
        }),
      campaigns: await Promise.all(
        list.map(async (c) => ({
          id: c.id,
          title: c.title,
          subject: c.subject,
          bodyText: c.bodyText,
          bodyHtml: c.bodyHtml,
          status: c.status,
          testSentAt: c.testSentAt,
          recipients: c.recipients,
          confirmedAt: c.confirmedAt,
          createdAt: c.createdAt,
          report: await campaignReport(d.db, c.id),
        })),
      ),
    };
  });

  app.post('/api/mailing/contacts', async (req, reply) => {
    const body = z.object({ csv: z.string().min(5).max(5_000_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, message: 'Вставьте CSV' });
    return reply409(reply, await importContacts(d.db, brand(), body.data.csv, ACTOR), false);
  });

  app.post('/api/mailing/campaigns', async (req, reply) => {
    const body = z.object({ artifactId: uuid }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, message: 'Выберите письмо' });
    return reply409(reply, await createCampaign(d.db, brand(), body.data.artifactId, ACTOR));
  });

  const campaignAction = (
    action: string,
    fn: (id: string, body: unknown) => Promise<{ ok: boolean; message: string }>,
  ) =>
    app.post<{ Params: { id: string } }>(
      `/api/mailing/campaigns/:id/${action}`,
      async (req, reply) => {
        if (!uuid.safeParse(req.params.id).success)
          return reply.code(400).send({ error: 'Неверный id' });
        const [c] = await d.db
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(sql`${campaigns.id} = ${req.params.id} and ${campaigns.brandId} = ${brand()}`);
        if (!c) return reply.code(404).send({ ok: false, message: 'Рассылка не найдена' });
        try {
          return await reply409(reply, await fn(req.params.id, req.body));
        } catch (err) {
          d.logger.warn({ err: errorToJson(err) }, 'mailing action failed');
          return reply
            .code(400)
            .send({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
        }
      },
    );
  campaignAction('test', (id) => d.workflow.sendTestEmail(id, ACTOR));
  campaignAction('confirm', (id, body) => {
    const b = z.object({ recipients: z.number().int().positive() }).safeParse(body);
    if (!b.success) return Promise.resolve({ ok: false, message: 'Укажите число получателей' });
    return d.workflow.confirmCampaign(id, b.data.recipients, ACTOR);
  });
  campaignAction('stop', (id) => stopCampaign(d.db, id, ACTOR));
}

/** «Параметры» of tool nodes on the board (read-only, from .env, no secrets). */
export function toolInfo(config: AppConfig) {
  return Object.fromEntries(
    TOOLS.map((t) => [t.id, { permissions: t.permissions(config), params: t.params(config) }]),
  );
}
