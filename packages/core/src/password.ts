import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the web panel (scrypt from node:crypto, no extra dependency).
 * Format: scrypt:N:r:p:saltBase64:hashBase64 — the only thing stored in .env.
 * (":" rather than "$": docker compose reads the same .env and would try to expand "$...".)
 */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
// scrypt needs ~128 * N * r bytes; raise Node's 32 MB default.
const MAXMEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || 128 * n * r * 2 > MAXMEM * 4)
    return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await derive(password, salt, n, r, p);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
