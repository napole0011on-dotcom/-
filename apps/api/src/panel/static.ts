import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serves the built panel (apps/web/dist) with an SPA fallback. In development Vite serves it instead. */
export async function registerStatic(app: FastifyInstance, distDir: string): Promise<boolean> {
  if (!existsSync(path.join(distDir, 'index.html'))) return false;
  await app.register(fastifyStatic, { root: distDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
  return true;
}
