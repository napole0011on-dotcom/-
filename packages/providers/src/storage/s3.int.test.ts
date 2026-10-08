import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv } from '@cms/core';
import { S3Storage } from './s3.js';

describe('S3Storage against docker compose storage', () => {
  loadDotEnv();
  const config = loadConfig({ ...process.env, STORAGE_DRIVER: 's3' });
  if (config.storage.driver !== 's3') throw new Error('unreachable');
  const storage = new S3Storage(config.storage);
  afterAll(() => storage.destroy());

  it('passes health check', async () => {
    await expect(storage.healthCheck()).resolves.toBeUndefined();
  });

  it('round-trips an object', async () => {
    const key = `test/${randomUUID()}.bin`;
    const body = Buffer.from([0, 1, 2, 255]);
    await storage.put(key, body, 'application/octet-stream');
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.get(key)).equals(body)).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('rejects wrong credentials', async () => {
    if (config.storage.driver !== 's3') return;
    const bad = new S3Storage({ ...config.storage, secretAccessKey: 'wrong-secret' });
    await expect(bad.healthCheck()).rejects.toThrow();
    bad.destroy();
  });
});
