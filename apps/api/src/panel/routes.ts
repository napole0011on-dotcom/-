import { timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorToJson, type Actor, type Logger, type PanelConfig } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import type { DecisionResult, Workflow } from '@cms/agents';
import {
  approvalQueue,
  agentCards,
  llmCallText,
  llmStatus,
  runCard,
  spendOverview,
  taskBoard,
  taskDetail,
  type QueryDeps,
} from './queries.js';
import { SESSION_COOKIE, login, logout, touchSession, type Session } from './sessions.js';

/** Sends a short copy of panel decisions to the owner's Telegram (no-op without a bot token). */
export interface Mirror {
  notify(text: string, reopenTaskId?: string): Promise<void>;
}

export interface PanelDeps extends QueryDeps {
  workflow: Workflow;
  panel: PanelConfig & { passwordHash: string };
  mirror: Mirror;
  logger: Logger;
  /** Origins allowed to send state-changing requests (the panel itself and the Vite dev server). */
  allowedOrigins: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    panelSession?: Session;
  }
}

const ACTOR: Actor = { kind: 'human', id: 'panel:owner' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const uuid = z.uuid();

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function audit(
  db: Db,
  brandId: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  await db
    .insert(schema.auditLog)
    .values({ brandId, actorKind: 'human', actorId: ACTOR.id, action, details });
}

export async function registerPanel(app: FastifyInstance, d: PanelDeps): Promise<void> {
  await app.register(cookie);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });

  // Security gate for every /api request.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (!origin || !d.allowedOrigins.includes(origin)) {
        return reply.code(403).send({ error: 'Запрос с чужого источника отклонён' });
      }
    }
    if (req.url === '/api/login') return;
    const session = await touchSession(d.db, d.panel, req.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Нужно войти' });
    if (MUTATING.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, session.csrfToken)) {
        return reply.code(403).send({ error: 'Неверный CSRF-токен, обновите страницу' });
      }
    }
    req.panelSession = session;
  });

  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: false };

  // ------------------------------------------------------------------ auth
  app.post('/api/login', async (req, reply) => {
    const body = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Введите пароль' });
    const r = await login(d.db, d.panel, body.data.password);
    if (!r.ok) {
      await audit(
        d.db,
        d.brandId(),
        r.reason === 'locked' ? 'panel_login_locked' : 'panel_login_failed',
        {
          lockedUntil: r.lockedUntil?.toISOString() ?? null,
        },
      );
      if (r.reason === 'locked') {
        return reply
          .code(429)
          .send({ error: 'Вход временно заблокирован', lockedUntil: r.lockedUntil });
      }
      return reply.code(401).send({ error: 'Неверный пароль', attemptsLeft: r.attemptsLeft });
    }
    await audit(d.db, d.brandId(), 'panel_login');
    reply.setCookie(SESSION_COOKIE, r.sessionToken, {
      ...cookieOpts,
      expires: r.session.expiresAt,
    });
    return {
      csrfToken: r.session.csrfToken,
      expiresAt: r.session.expiresAt,
      idleMinutes: d.panel.sessionIdleMinutes,
    };
  });

  app.post('/api/logout', async (req, reply) => {
    await logout(d.db, req.cookies[SESSION_COOKIE]);
    await audit(d.db, d.brandId(), 'panel_logout');
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/api/session', (req) => ({
    csrfToken: req.panelSession!.csrfToken,
    expiresAt: req.panelSession!.expiresAt,
    idleMinutes: d.panel.sessionIdleMinutes,
  }));

  // ------------------------------------------------------------------ reads
  app.get('/api/status', () => llmStatus(d));
  app.get('/api/agents', async () => agentCards(d));
  app.get('/api/tasks', async () => taskBoard(d));
  app.get('/api/approvals', async () => approvalQueue(d));
  app.get('/api/spend', async () => spendOverview(d));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    return (
      (await taskDetail(d, req.params.id)) ?? reply.code(404).send({ error: 'Задача не найдена' })
    );
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    return (await runCard(d, req.params.id)) ?? reply.code(404).send({ error: 'Запуск не найден' });
  });
  app.get<{ Params: { id: string } }>('/api/llm-calls/:id/text', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success)
      return reply.code(400).send({ error: 'Неверный id' });
    return (await llmCallText(d, req.params.id)) ?? reply.code(404).send({ error: 'Не найдено' });
  });

  // ------------------------------------------------------------------ actions (same functions as the bot)
  const titleOf = async (taskId: string) =>
    (
      await d.db
        .select({ t: schema.tasks.title })
        .from(schema.tasks)
        .where(sql`${schema.tasks.id} = ${taskId}`)
    )[0]?.t ?? '';
  const taskOfArtifact = async (artifactId: string) =>
    (
      await d.db
        .select({ t: schema.artifacts.taskId })
        .from(schema.artifacts)
        .where(sql`${schema.artifacts.id} = ${artifactId}`)
    )[0]?.t;

  async function act(
    reply: FastifyReply,
    taskId: string | undefined,
    fn: () => Promise<DecisionResult>,
    reopen = false,
  ) {
    try {
      const r = await fn();
      if (r.ok && taskId) {
        await d.mirror
          .notify(
            `🖥 В панели: ${r.message} — «${await titleOf(taskId)}»`,
            reopen ? taskId : undefined,
          )
          .catch((err: unknown) => {
            d.logger.warn({ err: errorToJson(err) }, 'telegram mirror failed');
          });
      }
      return reply.code(r.ok ? 200 : 409).send(r);
    } catch (err) {
      d.logger.warn({ err: errorToJson(err) }, 'panel action failed');
      return reply
        .code(400)
        .send({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
    }
  }

  app.post('/api/tasks', async (req, reply) => {
    const body = z
      .object({ brief: z.string().trim().min(10, 'Бриф слишком короткий').max(8000) })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ ok: false, message: body.error.issues[0]!.message });
    try {
      const { taskId } = await d.workflow.submitBrief(d.brandId(), body.data.brief, ACTOR);
      await d.mirror
        .notify(`🖥 В панели создана задача: «${await titleOf(taskId)}». CEO готовит план.`)
        .catch(() => undefined);
      return { ok: true, taskId, message: 'Задача создана, CEO готовит план' };
    } catch (err) {
      return reply
        .code(400)
        .send({ ok: false, message: err instanceof Error ? err.message : 'Ошибка' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/plan', async (req, reply) => {
    const body = z
      .object({
        action: z.enum(['approve', 'change', 'cancel']),
        comment: z.string().trim().max(4000).optional(),
      })
      .refine((b) => b.action !== 'change' || (b.comment?.length ?? 0) > 0, {
        error: 'Напишите, что изменить',
      })
      .safeParse(req.body);
    if (!uuid.safeParse(req.params.id).success || !body.success) {
      return reply
        .code(400)
        .send({ ok: false, message: body.success ? 'Неверный id' : body.error.issues[0]!.message });
    }
    return act(reply, req.params.id, () =>
      d.workflow.decidePlan(req.params.id, body.data.action, ACTOR, body.data.comment),
    );
  });

  app.post<{ Params: { id: string } }>('/api/artifacts/:id/decision', async (req, reply) => {
    const body = z
      .object({
        action: z.enum(['approve', 'revise', 'regenerate']),
        variant: z.number().int().min(1).max(3).nullable().optional(),
        comment: z.string().trim().max(4000).optional(),
      })
      .refine((b) => b.action !== 'revise' || (b.comment?.length ?? 0) > 0, {
        error: 'Напишите, что поправить',
      })
      .safeParse(req.body);
    if (!uuid.safeParse(req.params.id).success || !body.success) {
      return reply
        .code(400)
        .send({ ok: false, message: body.success ? 'Неверный id' : body.error.issues[0]!.message });
    }
    const taskId = await taskOfArtifact(req.params.id);
    return act(reply, taskId, () =>
      d.workflow.decideArtifact(req.params.id, body.data.action, ACTOR, {
        variant: body.data.variant ?? null,
        comment: body.data.comment ?? null,
      }),
    );
  });

  const taskAction = (
    path: string,
    fn: (id: string, comment?: string) => Promise<DecisionResult>,
    reopen = false,
  ) =>
    app.post<{ Params: { id: string } }>(`/api/tasks/:id/${path}`, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success)
        return reply.code(400).send({ ok: false, message: 'Неверный id' });
      const body = z
        .object({ comment: z.string().trim().max(4000).optional() })
        .safeParse(req.body ?? {});
      return act(
        reply,
        req.params.id,
        () => fn(req.params.id, body.success ? body.data.comment : undefined),
        reopen,
      );
    });

  taskAction('approve-all', (id) => d.workflow.approveAll(id, ACTOR));
  taskAction('reject', (id, comment) => d.workflow.rejectPackage(id, ACTOR, comment ?? null), true);
  taskAction('reopen', (id) => d.workflow.reopenPackage(id, ACTOR));
  taskAction('cancel', (id) => d.workflow.cancelTask(id, ACTOR));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/budget', async (req, reply) => {
    const body = z.object({ extraUsd: z.union([z.literal(1), z.literal(5)]) }).safeParse(req.body);
    if (!uuid.safeParse(req.params.id).success || !body.success)
      return reply.code(400).send({ ok: false, message: 'Неверный запрос' });
    return act(reply, req.params.id, () =>
      d.workflow.approveBudget(req.params.id, body.data.extraUsd, ACTOR),
    );
  });
}
