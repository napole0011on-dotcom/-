import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { PermanentError } from '@cms/core';

/** ffmpeg / ffprobe wrappers for the transcription pipeline (no shell: arguments as an array). */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

function exec(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on('error', (e) =>
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new PermanentError(
              'media_tool_missing',
              `Не найдена программа ${bin}. Windows: winget install --id Gyan.FFmpeg -e, затем новое окно терминала`,
            )
          : e,
      ),
    );
    p.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new PermanentError('media_tool_failed', `${bin}: код ${code}. ${err.trim()}`)),
    );
  });
}

/** Duration in seconds (ffprobe). An unreadable file is a permanent error with a clear text. */
export async function probeDuration(t: MediaTools, file: string): Promise<number> {
  const out = await exec(t.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const sec = Number(out.trim());
  if (!Number.isFinite(sec) || sec <= 0)
    throw new PermanentError('media_unreadable', 'Не удалось определить длительность файла');
  return sec;
}

/** One chunk as 16 kHz mono 16-bit WAV (what speech engines expect). */
export async function extractWav(
  t: MediaTools,
  input: string,
  output: string,
  range: { start: number; duration: number },
  signal?: AbortSignal,
): Promise<void> {
  await exec(
    t.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-ss',
      range.start.toFixed(3),
      '-t',
      range.duration.toFixed(3),
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      output,
    ],
    signal,
  );
}

/** Refuses to start when the disk cannot hold the temporary files. */
export async function assertFreeSpace(dir: string, needBytes: number): Promise<void> {
  const s = await statfs(dir);
  const free = s.bavail * s.bsize;
  if (free < needBytes)
    throw new PermanentError(
      'disk_full',
      `Мало места на диске для временных файлов: нужно ~${Math.ceil(needBytes / 1e6)} МБ, свободно ${Math.floor(free / 1e6)} МБ`,
    );
}
