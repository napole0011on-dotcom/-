import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes structured JSON with level label, timestamp and correlation ids', () => {
    const { lines, destination } = capture();
    const log = createLogger({ name: 'test', destination }).child({ taskId: 't1', runId: 'r1' });
    log.info({ step: 'plan' }, 'hello');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      service: 'test',
      taskId: 't1',
      runId: 'r1',
      step: 'plan',
      msg: 'hello',
    });
    expect(typeof entry.time).toBe('string');
  });

  it('redacts secrets at top level and nested', () => {
    const { lines, destination } = capture();
    const log = createLogger({ destination });
    log.info({
      apiKey: 'sk-top',
      provider: { token: 'tok-nested', options: { password: 'pw-deep' } },
      req: { headers: { authorization: 'Bearer abc' } },
    });
    const out = lines.join('');
    for (const secret of ['sk-top', 'tok-nested', 'pw-deep', 'Bearer abc']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });
});
