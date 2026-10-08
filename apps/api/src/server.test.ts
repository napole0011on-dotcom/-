import { describe, expect, it } from 'vitest';
import { createLogger } from '@cms/core';
import { buildServer } from './server.js';

const logger = createLogger({ level: 'silent' });

describe('GET /health', () => {
  it('returns 200 when all checks pass', async () => {
    const app = buildServer({ logger, checks: { db: async () => {}, storage: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', storage: 'ok' } });
    await app.close();
  });

  it('returns 503 and hides error details when a check fails', async () => {
    const app = buildServer({
      logger,
      checks: {
        db: () => Promise.reject(new Error('password authentication failed for user secret-user')),
        storage: async () => {},
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { db: 'fail', storage: 'ok' } });
    expect(res.body).not.toContain('secret-user');
    await app.close();
  });

  it('treats a hanging check as failed', async () => {
    const app = buildServer({
      logger,
      checkTimeoutMs: 50,
      checks: { db: () => new Promise<void>(() => {}) },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
