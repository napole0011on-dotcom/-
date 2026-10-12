import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SttProvider, SttResult, SttSegment } from '../types.js';

interface WhisperJson {
  result?: { language?: string };
  transcription?: { offsets?: { from: number; to: number }; text?: string }[];
}

/**
 * Local whisper.cpp: runs `whisper-cli -m <model> -f <wav> -l <lang> -oj -of <out>` and reads
 * the JSON it writes. $0, the audio never leaves the computer.
 * TODO(verify): flags against the whisper.cpp version installed on the owner's machine
 * (checked against the README of ggml-org/whisper.cpp: -m, -f, -l, -oj, -of, -np).
 */
export class WhisperCppProvider implements SttProvider {
  readonly name = 'whisper.cpp';
  readonly pricePerMinuteUsd = 0;

  constructor(
    private readonly bin: string,
    private readonly model: string,
  ) {}

  async transcribe(
    wav: { path: string; durationSec: number },
    opts: { language?: string; signal?: AbortSignal },
  ): Promise<SttResult> {
    const outBase = `${wav.path}.whisper`;
    const args = ['-m', this.model, '-f', wav.path, '-oj', '-of', outBase, '-np'];
    if (opts.language) args.push('-l', opts.language);
    await run(this.bin, args, opts.signal);
    const jsonPath = `${outBase}.json`;
    try {
      const data = JSON.parse(await readFile(jsonPath, 'utf8')) as WhisperJson;
      const segments: SttSegment[] = (data.transcription ?? [])
        .map((t) => ({
          start: (t.offsets?.from ?? 0) / 1000,
          end: (t.offsets?.to ?? 0) / 1000,
          text: (t.text ?? '').trim(),
        }))
        .filter((s) => s.text);
      return {
        text: segments.map((s) => s.text).join(' '),
        segments,
        language: data.result?.language ?? opts.language ?? 'auto',
        durationSec: wav.durationSec,
        confidence: null,
        provider: this.name,
        model: path.basename(this.model),
      };
    } finally {
      await rm(jsonPath, { force: true });
    }
  }
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, signal });
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on('error', (e) =>
      reject(
        new Error(
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Не найдена программа ${bin}: установите whisper.cpp и укажите WHISPER_CPP_BIN`
            : e.message,
        ),
      ),
    );
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} завершился с кодом ${code}: ${err}`)),
    );
  });
}
