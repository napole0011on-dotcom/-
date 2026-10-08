import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@cms/core';
import { createProviders } from './factory.js';
import { MockImageProvider } from './mock/image.js';
import { MockInstagramDataProvider } from './mock/instagram.js';
import { StubPublisher } from './publisher.js';
import { assertSafeKey } from './storage/keys.js';
import { LocalFsStorage } from './storage/local.js';

const env = { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd' };

describe('MockImageProvider', () => {
  it('returns a PNG of the requested size and is deterministic for prompt+seed', async () => {
    const p = new MockImageProvider();
    const a = await p.generate({ prompt: 'cat', width: 108, height: 135, seed: 42 });
    const b = await p.generate({ prompt: 'cat', width: 108, height: 135, seed: 42 });
    const meta = await sharp(a.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 108, 135]);
    expect(a.data.equals(b.data)).toBe(true);
    expect(a.params).toMatchObject({ seed: 42, prompt: 'cat' });
  });

  it('always reports the seed it used', async () => {
    const r = await new MockImageProvider().generate({ prompt: 'dog', width: 10, height: 10 });
    expect(Number.isInteger(r.seed)).toBe(true);
  });
});

describe('MockInstagramDataProvider', () => {
  it('filters by date and labels data as mock', async () => {
    const posts = await new MockInstagramDataProvider().listPosts({
      since: new Date('2026-09-02'),
    });
    expect(posts.map((p) => p.postId)).toEqual(['mock-2']);
    expect(posts.every((p) => p.source === 'mock')).toBe(true);
  });
});

describe('StubPublisher', () => {
  it('never publishes, and says why', async () => {
    const req = { brandId: 'b', taskId: 't', artifactIds: [] };
    expect(await new StubPublisher({ publishEnabled: false, dryRun: true }).publish(req)).toEqual({
      status: 'skipped',
      reason: 'PUBLISH_ENABLED=false',
    });
    expect(
      (await new StubPublisher({ publishEnabled: true, dryRun: false }).publish(req)).status,
    ).toBe('skipped');
  });
});

describe('createProviders', () => {
  it('uses mocks by default', () => {
    const p = createProviders(loadConfig(env, '/repo'));
    expect([p.image.name, p.instagram.name, p.notifier.name, p.publisher.name]).toEqual([
      'mock',
      'mock',
      'mock',
      'stub',
    ]);
  });

  it('fails loudly for real mode instead of silently using mocks', () => {
    expect(() => createProviders(loadConfig({ ...env, PROVIDERS_MODE: 'real' }, '/repo'))).toThrow(
      /not implemented/,
    );
  });
});

describe('storage keys', () => {
  it.each(['', '/abs', '../up', 'a/../b', 'a//b', 'C:/x', 'a\\b', './a'])('rejects %j', (k) => {
    expect(() => assertSafeKey(k)).toThrow();
  });
  it('accepts normal keys', () => {
    expect(assertSafeKey('brand/1/images/a.png')).toEqual(['brand', '1', 'images', 'a.png']);
  });
});

describe('LocalFsStorage', () => {
  it('round-trips objects and passes health check', async () => {
    const s = new LocalFsStorage(mkdtempSync(path.join(tmpdir(), 'store-')));
    await s.put('brand/1/a.txt', Buffer.from('hello'), 'text/plain');
    expect((await s.get('brand/1/a.txt')).toString()).toBe('hello');
    expect(await s.exists('brand/1/a.txt')).toBe(true);
    await s.delete('brand/1/a.txt');
    expect(await s.exists('brand/1/a.txt')).toBe(false);
    await expect(s.healthCheck()).resolves.toBeUndefined();
  });
});
