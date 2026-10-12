import type { SttSegment } from '@cms/providers';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 3725.5 -> "01:02:05,500" (SRT) or "01:02:05.500" (VTT). */
export function timecode(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** "01:02:05" for the panel and summaries. */
export const shortTime = (sec: number) => timecode(sec, '.').slice(0, 8);

export function toSrt(segments: SttSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${timecode(s.start, ',')} --> ${timecode(s.end, ',')}\n${s.text}\n`)
    .join('\n');
}

export function toVtt(segments: SttSegment[]): string {
  return `WEBVTT\n\n${segments
    .map((s) => `${timecode(s.start, '.')} --> ${timecode(s.end, '.')}\n${s.text}\n`)
    .join('\n')}`;
}

/** Plain text with a timecode every paragraph (about one per minute). */
export function toTxt(segments: SttSegment[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let paraStart = 0;
  for (const s of segments) {
    if (para.length === 0) paraStart = s.start;
    para.push(s.text);
    if (s.end - paraStart >= 60) {
      out.push(`[${shortTime(paraStart)}] ${para.join(' ')}`);
      para = [];
    }
  }
  if (para.length) out.push(`[${shortTime(paraStart)}] ${para.join(' ')}`);
  return `${out.join('\n\n')}\n`;
}
