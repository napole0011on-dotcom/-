import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PermanentError, type Actor, type AppConfig, type Logger } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import {
  assertFreeSpace,
  createRun,
  createTask,
  extractWav,
  finalizeCost,
  probeDuration,
  releaseCost,
  reserveCost,
  type BudgetContext,
  type Run,
} from '@cms/engine';
import type { ObjectStorage, SttProvider, SttSegment } from '@cms/providers';
import { emitEvent } from '../events.js';
import { toSrt, toTxt, toVtt } from './subtitles.js';

const { mediaFiles, transcripts, runs, auditLog } = schema;

export type MediaKind = 'voice' | 'video';
export const MEDIA_TASK_KIND = 'media';

/** Tool step ids in the registry (board nodes) for each media kind. */
export const MEDIA_TOOL: Record<MediaKind, string> = {
  voice: 'stt_voice',
  video: 'video_transcribe',
};

const VOICE_EXT = ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'webm', 'aac', 'flac'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'm4v'];

export interface MediaDeps {
  db: Db;
  storage: ObjectStorage;
  stt: SttProvider;
  config: AppConfig;
  budget: BudgetContext;
  logger: Logger;
}

export interface IngestResult {
  ok: boolean;
  message: string;
  fileId?: string;
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** Checks type and size, stores the file and registers it (expires after MEDIA_RETENTION_DAYS). */
export async function ingestMedia(
  d: Pick<MediaDeps, 'db' | 'storage' | 'config'>,
  brandId: string,
  file: {
    kind: MediaKind;
    source: 'telegram' | 'panel';
    name: string;
    mimeType: string;
    data: Buffer;
  },
  actor: Actor,
): Promise<IngestResult> {
  const ext = path.extname(file.name).slice(1).toLowerCase();
  const allowed = file.kind === 'voice' ? VOICE_EXT : VIDEO_EXT;
  if (!allowed.includes(ext))
    return {
      ok: false,
      message: `Формат .${ext || '?'} не поддерживается. Можно: ${allowed.join(', ')}`,
    };
  const max = file.kind === 'voice' ? d.config.media.voiceMaxBytes : d.config.media.videoMaxBytes;
  if (file.data.length > max)
    return {
      ok: false,
      message: `Файл ${mb(file.data.length)} МБ больше лимита ${mb(max)} МБ (${file.kind === 'voice' ? 'VOICE_MAX_MB' : 'VIDEO_MAX_MB'})`,
    };
  if (file.data.length === 0) return { ok: false, message: 'Файл пустой' };
  const id = randomUUID();
  const key = `media/${brandId}/${id}.${ext}`;
  await d.storage.put(key, file.data, file.mimeType);
  await d.db.insert(mediaFiles).values({
    id,
    brandId,
    kind: file.kind,
    source: file.source,
    // Only the base name: never a path from the client.
    originalName: path.basename(file.name).slice(0, 200),
    storageKey: key,
    mimeType: file.mimeType,
    sizeBytes: file.data.length,
    sha256: createHash('sha256').update(file.data).digest('hex'),
    expiresAt: sql`now() + make_interval(days => ${d.config.media.retentionDays})`,
    createdBy: actor.id,
  });
  await d.db.insert(auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action: 'media_uploaded',
    details: { fileId: id, kind: file.kind, source: file.source, sizeBytes: file.data.length },
  });
  return { ok: true, message: 'Файл принят', fileId: id };
}

/** Queues a transcription (service task, hidden from the board) and returns its id. */
export async function startTranscription(
  d: Pick<MediaDeps, 'db' | 'config'> & { enqueue: (runId: string) => Promise<unknown> },
  brandId: string,
  fileId: string,
  opts: { notifyChatId?: string | null; actor: Actor },
): Promise<{ transcriptId: string; taskId: string }> {
  const [file] = await d.db
    .select()
    .from(mediaFiles)
    .where(sql`${mediaFiles.id} = ${fileId} and ${mediaFiles.brandId} = ${brandId}`);
  if (!file) throw new PermanentError('media_not_found', 'Файл не найден');
  const kind = file.kind as MediaKind;
  const { id: taskId } = await createTask(d.db, {
    brandId,
    kind: MEDIA_TASK_KIND,
    title: `Расшифровка: ${file.originalName}`,
    brief: { text: `Расшифровка файла ${file.originalName}`, fileId },
    budgetUsd: d.config.budget.taskUsd,
    actor: opts.actor,
  });
  const [t] = await d.db
    .insert(transcripts)
    .values({ brandId, fileId, taskId, notifyChatId: opts.notifyChatId ?? null })
    .returning({ id: transcripts.id });
  const { run } = await createRun(d.db, {
    brandId,
    taskId,
    agent: MEDIA_TOOL[kind],
    idempotencyKey: `transcribe:${t!.id}`,
    input: { kind: 'transcribe', transcriptId: t!.id },
  });
  await d.enqueue(run.id);
  return { transcriptId: t!.id, taskId };
}

export type TranscriptRow = typeof transcripts.$inferSelect;

/**
 * The transcription itself (queue worker): storage -> temp file -> duration and limits ->
 * chunks of STT_CHUNK_SECONDS as 16 kHz mono WAV -> STT -> segments appended after every chunk
 * (a crash or retry continues from the last finished chunk) -> txt/srt/vtt/json in storage.
 * Paid engines go through the budget per chunk (minutes of audio); local/mock cost $0.
 */
export async function runTranscription(
  d: MediaDeps,
  run: Run,
  signal: AbortSignal,
): Promise<TranscriptRow> {
  const transcriptId = (run.input as { transcriptId: string }).transcriptId;
  let [t] = await d.db
    .select()
    .from(transcripts)
    .where(sql`${transcripts.id} = ${transcriptId}`);
  if (!t) throw new PermanentError('transcript_not_found', 'Расшифровка не найдена');
  if (t.status === 'done' || t.status === 'cancelled') return t;
  const [file] = await d.db
    .select()
    .from(mediaFiles)
    .where(sql`${mediaFiles.id} = ${t.fileId}`);
  if (!file || file.deletedAt) throw new PermanentError('media_gone', 'Файл уже удалён');
  const kind = file.kind as MediaKind;
  const m = d.config.media;
  const dir = path.join(m.tmpDir, transcriptId);
  await mkdir(dir, { recursive: true });
  const fail = async (message: string) => {
    await d.db
      .update(transcripts)
      .set({ status: 'failed', error: message, updatedAt: sql`now()` })
      .where(sql`${transcripts.id} = ${transcriptId}`);
  };
  try {
    await assertFreeSpace(dir, file.sizeBytes * 2 + 64 * 1024 * 1024);
    const input = path.join(dir, `input${path.extname(file.storageKey)}`);
    await writeFile(input, await d.storage.get(file.storageKey));
    const duration = await probeDuration(m, input);
    const maxSec = kind === 'voice' ? m.voiceMaxSeconds : m.videoMaxSeconds;
    if (duration > maxSec) {
      const msg = `Запись ${Math.round(duration / 60)} мин длиннее лимита ${Math.round(maxSec / 60)} мин (${kind === 'voice' ? 'VOICE_MAX_SECONDS' : 'VIDEO_MAX_SECONDS'})`;
      await fail(msg);
      throw new PermanentError('media_too_long', msg);
    }
    const total = Math.max(1, Math.ceil(duration / m.chunkSeconds));
    await d.db
      .update(mediaFiles)
      .set({ durationSec: duration.toFixed(2) })
      .where(sql`${mediaFiles.id} = ${file.id}`);
    await d.db
      .update(transcripts)
      .set({
        status: 'running',
        chunksTotal: total,
        durationSec: duration.toFixed(2),
        provider: d.stt.name,
        updatedAt: sql`now()`,
      })
      .where(sql`${transcripts.id} = ${transcriptId}`);

    for (let i = t.chunksDone; i < total; i++) {
      // "Отменить" in the panel: stop between chunks, keep what is done.
      const [cur] = await d.db
        .select({ status: transcripts.status })
        .from(transcripts)
        .where(sql`${transcripts.id} = ${transcriptId}`);
      if (cur?.status === 'cancelled') break;
      if (signal.aborted) throw new Error('aborted');
      const start = i * m.chunkSeconds;
      const len = Math.min(m.chunkSeconds, duration - start);
      const wav = path.join(dir, `chunk-${i}.wav`);
      await extractWav(m, input, wav, { start, duration: len }, signal);
      const reservation = await reserveCost(d.db, d.budget, {
        brandId: file.brandId,
        taskId: t.taskId,
        runId: run.id,
        agent: MEDIA_TOOL[kind],
        kind: 'stt',
        provider: d.stt.name,
        model: 'stt',
        estimateUsd: (len / 60) * d.stt.pricePerMinuteUsd,
        idempotencyKey: `stt:${transcriptId}:${i}`,
      });
      let segs: SttSegment[];
      try {
        const r = await d.stt.transcribe(
          { path: wav, durationSec: len },
          { language: m.language, signal },
        );
        segs = r.segments.map((s) => ({ ...s, start: s.start + start, end: s.end + start }));
        await finalizeCost(d.db, reservation.id, {
          costUsd: (len / 60) * d.stt.pricePerMinuteUsd,
          model: r.model,
          estimated: false,
          units: Math.ceil(len),
        });
        await d.db
          .update(transcripts)
          .set({
            segments: sql`${transcripts.segments} || ${JSON.stringify(segs)}::jsonb`,
            chunksDone: i + 1,
            language: r.language,
            model: r.model,
            updatedAt: sql`now()`,
          })
          .where(sql`${transcripts.id} = ${transcriptId} and ${transcripts.chunksDone} = ${i}`);
      } catch (err) {
        await releaseCost(d.db, reservation.id);
        throw err;
      }
      await rm(wav, { force: true });
      await d.db
        .update(runs)
        .set({ progress: Math.round(((i + 1) / total) * 100) })
        .where(sql`${runs.id} = ${run.id}`);
    }

    [t] = await d.db
      .select()
      .from(transcripts)
      .where(sql`${transcripts.id} = ${transcriptId}`);
    const segments = (t!.segments as SttSegment[]) ?? [];
    const text = segments.map((s) => s.text).join(' ');
    const base = `transcripts/${file.brandId}/${transcriptId}`;
    const outputs = [
      { name: 'transcript.txt', mimeType: 'text/plain; charset=utf-8', body: toTxt(segments) },
      { name: 'subtitles.srt', mimeType: 'application/x-subrip', body: toSrt(segments) },
      { name: 'subtitles.vtt', mimeType: 'text/vtt', body: toVtt(segments) },
      {
        name: 'transcript.json',
        mimeType: 'application/json',
        body: JSON.stringify(
          { language: t!.language, durationSec: duration, provider: t!.provider, segments },
          null,
          2,
        ),
      },
    ];
    const files = [];
    for (const o of outputs) {
      const key = `${base}/${o.name}`;
      await d.storage.put(key, Buffer.from(o.body, 'utf8'), o.mimeType);
      files.push({ name: o.name, key, mimeType: o.mimeType });
    }
    const cancelled = t!.status === 'cancelled';
    [t] = await d.db
      .update(transcripts)
      .set({
        status: cancelled ? 'cancelled' : 'done',
        text,
        files,
        error: null,
        updatedAt: sql`now()`,
      })
      .where(sql`${transcripts.id} = ${transcriptId}`)
      .returning();
    await emitEvent(d.db, {
      brandId: file.brandId,
      agent: MEDIA_TOOL[kind],
      taskId: t!.taskId,
      runId: run.id,
      kind: 'finished',
      text: `${kind === 'voice' ? 'Голосовое' : 'Видео'} расшифровано: ${Math.round(duration)} с`,
      costUsd: 0,
    });
    return t!;
  } catch (err) {
    if (err instanceof PermanentError) await fail(err.message);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deletes audio/video whose retention ended (transcripts and subtitles stay). */
export async function purgeExpiredMedia(
  d: Pick<MediaDeps, 'db' | 'storage' | 'logger'>,
): Promise<number> {
  const rows = await d.db
    .select()
    .from(mediaFiles)
    .where(sql`${mediaFiles.deletedAt} is null and ${mediaFiles.expiresAt} < now()`)
    .limit(200);
  for (const f of rows) {
    await d.storage.delete(f.storageKey).catch(() => undefined);
    await d.db
      .update(mediaFiles)
      .set({ deletedAt: sql`now()` })
      .where(sql`${mediaFiles.id} = ${f.id}`);
  }
  if (rows.length) d.logger.info({ files: rows.length }, 'expired media deleted');
  return rows.length;
}
