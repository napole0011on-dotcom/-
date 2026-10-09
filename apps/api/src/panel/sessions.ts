import { createHash, randomBytes } from 'node:crypto';
import { verifyPassword, type PanelConfig } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';

const { panelSessions, panelLoginState } = schema;

export const SESSION_COOKIE = 'cms_session';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export interface Session {
  csrfToken: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

export type LoginResult =
  | { ok: true; sessionToken: string; session: Session }
  | { ok: false; reason: 'locked'; lockedUntil: Date }
  | { ok: false; reason: 'wrong_password'; attemptsLeft: number; lockedUntil: Date | null };

/**
 * Checks the password with a persistent throttle: N consecutive failures lock the login
 * for M minutes (state is in the DB, so a restart does not reset it).
 */
export async function login(
  db: Db,
  cfg: PanelConfig & { passwordHash: string },
  password: string,
  now = new Date(),
): Promise<LoginResult> {
  // Verify outside the transaction (scrypt is slow); the throttle update is atomic.
  const [state] = await db
    .select()
    .from(panelLoginState)
    .where(sql`${panelLoginState.id} = 1`);
  if (state?.lockedUntil && state.lockedUntil > now)
    return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil };

  const valid = await verifyPassword(password, cfg.passwordHash);
  if (!valid) {
    return db.transaction(async (tx) => {
      await tx.insert(panelLoginState).values({ id: 1 }).onConflictDoNothing();
      const [cur] = await tx
        .select()
        .from(panelLoginState)
        .where(sql`${panelLoginState.id} = 1`)
        .for('update');
      const expiredLock = cur!.lockedUntil && cur!.lockedUntil <= now;
      const failed = (expiredLock ? 0 : cur!.failedCount) + 1;
      const lock =
        failed >= cfg.loginMaxAttempts
          ? new Date(now.getTime() + cfg.loginLockMinutes * 60_000)
          : null;
      await tx
        .update(panelLoginState)
        .set({ failedCount: lock ? 0 : failed, lockedUntil: lock, updatedAt: sql`now()` })
        .where(sql`${panelLoginState.id} = 1`);
      return lock
        ? ({ ok: false, reason: 'locked', lockedUntil: lock } as const)
        : ({
            ok: false,
            reason: 'wrong_password',
            attemptsLeft: cfg.loginMaxAttempts - failed,
            lockedUntil: null,
          } as const);
    });
  }

  await db
    .insert(panelLoginState)
    .values({ id: 1, failedCount: 0, lockedUntil: null })
    .onConflictDoUpdate({
      target: panelLoginState.id,
      set: { failedCount: 0, lockedUntil: null, updatedAt: sql`now()` },
    });

  const sessionToken = token();
  const csrfToken = token();
  const expiresAt = new Date(now.getTime() + cfg.sessionMaxHours * 3_600_000);
  await db
    .insert(panelSessions)
    .values({ tokenHash: sha256(sessionToken), csrfToken, lastSeenAt: now, expiresAt });
  // Housekeeping: drop sessions that can no longer be used.
  await db
    .delete(panelSessions)
    .where(sql`${panelSessions.expiresAt} < ${now.toISOString()}::timestamptz`);
  return {
    ok: true,
    sessionToken,
    session: {
      csrfToken,
      expiresAt,
      idleExpiresAt: new Date(now.getTime() + cfg.sessionIdleMinutes * 60_000),
    },
  };
}

/** Returns the session if it exists and is within both timeouts; refreshes the idle timer. */
export async function touchSession(
  db: Db,
  cfg: PanelConfig,
  sessionToken: string | undefined,
  now = new Date(),
): Promise<Session | null> {
  if (!sessionToken) return null;
  const hash = sha256(sessionToken);
  const [s] = await db
    .select()
    .from(panelSessions)
    .where(sql`${panelSessions.tokenHash} = ${hash}`);
  if (!s) return null;
  const idleDeadline = new Date(s.lastSeenAt.getTime() + cfg.sessionIdleMinutes * 60_000);
  if (s.expiresAt <= now || idleDeadline <= now) {
    await db.delete(panelSessions).where(sql`${panelSessions.tokenHash} = ${hash}`);
    return null;
  }
  await db
    .update(panelSessions)
    .set({ lastSeenAt: now })
    .where(sql`${panelSessions.tokenHash} = ${hash}`);
  return {
    csrfToken: s.csrfToken,
    expiresAt: s.expiresAt,
    idleExpiresAt: new Date(now.getTime() + cfg.sessionIdleMinutes * 60_000),
  };
}

export async function logout(db: Db, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await db.delete(panelSessions).where(sql`${panelSessions.tokenHash} = ${sha256(sessionToken)}`);
}
