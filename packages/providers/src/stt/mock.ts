import { createHash } from 'node:crypto';
import type { SttProvider, SttResult } from '../types.js';

const WORDS = [
  'Сегодня', 'расскажу', 'про', 'осеннее', 'меню', 'нашей', 'кофейни', 'тыквенный', 'латте',
  'и', 'новый', 'десерт', 'с', 'грушей', 'приходите', 'в', 'субботу', 'будет', 'дегустация',
]; // prettier-ignore

/**
 * Deterministic fake speech recognition: no engine, no network, $0. The text depends only
 * on the audio length, one segment per 5 seconds, so tests and timecodes are reproducible.
 */
export class MockSttProvider implements SttProvider {
  readonly name = 'mock';
  readonly pricePerMinuteUsd = 0;
  readonly calls: { path: string; durationSec: number }[] = [];

  transcribe(wav: { path: string; durationSec: number }): Promise<SttResult> {
    this.calls.push(wav);
    const segments = [];
    const n = Math.max(1, Math.ceil(wav.durationSec / 5));
    for (let i = 0; i < n; i++) {
      const h = createHash('sha256').update(`${i}`).digest();
      const words = Array.from({ length: 6 }, (_, j) => WORDS[(h[j]! + i) % WORDS.length]!);
      segments.push({
        start: i * 5,
        end: Math.min(wav.durationSec, (i + 1) * 5),
        text: `[MOCK] ${words.join(' ')}.`,
      });
    }
    return Promise.resolve({
      text: segments.map((s) => s.text).join(' '),
      segments,
      language: 'ru',
      durationSec: wav.durationSec,
      confidence: null,
      provider: this.name,
      model: 'mock-stt',
    });
  }
}
