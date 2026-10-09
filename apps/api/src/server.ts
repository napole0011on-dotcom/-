import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Logger } from '@cms/core';

export type HealthCheck = () => Promise<void>;

export interface ServerDeps {
  logger: Logger;
  /** Named dependency probes, e.g. { db, storage }. Each throws when unhealthy. */
  checks: Record<string, HealthCheck>;
  checkTimeoutMs?: number;
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      () => (clearTimeout(t), resolve()),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify({ loggerInstance: deps.logger as unknown as FastifyBaseLogger });
  const timeout = deps.checkTimeoutMs ?? 3_000;

  // 200 when every dependency answers, 503 otherwise. Error details go to logs, not to the response.
  app.get('/health', async (_req, reply) => {
    const entries = await Promise.all(
      Object.entries(deps.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeout);
          return [name, 'ok'] as const;
        } catch (err) {
          app.log.warn({ check: name, err }, 'health check failed');
          return [name, 'fail'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const ok = entries.every(([, s]) => s === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  return app;
}
