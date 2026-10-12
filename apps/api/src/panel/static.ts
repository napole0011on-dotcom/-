import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serves the built panel (apps/web/dist) with an SPA fallback. In development Vite serves it instead. */
export async function registerStatic(app: FastifyInstance, distDir: string): Promise<boolean> {
  if (!existsSync(path.join(distDir, 'index.html'))) return false;
  // wildcard: files are looked up on each request, so a rebuild works without restarting the API.
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0]!;
    // SPA routes get index.html; a missing file (e.g. an old /assets/x.js) is a real 404.
    if (req.method === 'GET' && !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname))
      return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
  return true;
}
