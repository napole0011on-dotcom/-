import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMigrationsDir, readMigrations } from './migrator.js';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('readMigrations', () => {
  it('orders migrations and pairs each with its down file', () => {
    const dir = dirWith({
      '0001_b.sql': 'b',
      '0001_b.down.sql': 'undo b',
      '0000_a.sql': 'a',
      '0000_a.down.sql': 'undo a',
    });
    expect(readMigrations(dir).map((m) => [m.name, m.down])).toEqual([
      ['0000_a', 'undo a'],
      ['0001_b', 'undo b'],
    ]);
  });

  it('refuses a migration without a rollback file', () => {
    const dir = dirWith({ '0000_a.sql': 'a' });
    expect(() => readMigrations(dir)).toThrow(/0000_a\.down\.sql/);
  });

  it('checksum ignores CRLF vs LF (Windows checkouts)', () => {
    const lf = readMigrations(dirWith({ '0000_a.sql': 'line1\nline2\n', '0000_a.down.sql': '' }));
    const crlf = readMigrations(
      dirWith({ '0000_a.sql': 'line1\r\nline2\r\n', '0000_a.down.sql': '' }),
    );
    expect(lf[0]!.checksum).toBe(crlf[0]!.checksum);
  });

  it('every real migration in the repo has a rollback', () => {
    expect(readMigrations(defaultMigrationsDir()).length).toBeGreaterThan(0);
  });
});
