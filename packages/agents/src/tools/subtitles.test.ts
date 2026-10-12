import { describe, expect, it } from 'vitest';
import { timecode, toSrt, toTxt, toVtt } from './subtitles.js';

const segs = [
  { start: 0, end: 2.5, text: 'Привет.' },
  { start: 61, end: 3725.5, text: 'Долго.' },
];

describe('subtitles', () => {
  it('formats timecodes', () => {
    expect(timecode(3725.5, ',')).toBe('01:02:05,500');
    expect(timecode(0.001, '.')).toBe('00:00:00.001');
  });
  it('writes SRT, VTT and text with timecodes', () => {
    expect(toSrt(segs)).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nПривет.\n\n2\n00:01:01,000 --> 01:02:05,500\nДолго.\n',
    );
    expect(toVtt(segs).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nПривет.')).toBe(true);
    expect(toTxt(segs)).toBe('[00:00:00] Привет. Долго.\n');
  });
});
