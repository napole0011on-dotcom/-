import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { hashPassword, verifyPassword } from './password.js';

describe('panel password hashing', () => {
  it('hashes with scrypt, verifies, rejects wrong passwords, salts every hash', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt:32768:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
    expect(await hashPassword('correct horse battery')).not.toBe(h);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('refuses short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/8 characters/);
  });

  it('the hash has no "$" (docker compose expands $ in .env) and is accepted by the config', async () => {
    const h = await hashPassword('another-password');
    expect(h).not.toContain('$');
    const c = loadConfig(
      { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd', PANEL_PASSWORD_HASH: h },
      '/repo',
    );
    expect(c.panel).toMatchObject({
      passwordHash: h,
      sessionIdleMinutes: 30,
      sessionMaxHours: 12,
      loginMaxAttempts: 5,
      loginLockMinutes: 5,
    });
  });

  it('API_HOST must be loopback', () => {
    expect(() =>
      loadConfig(
        { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd', API_HOST: '0.0.0.0' },
        '/repo',
      ),
    ).toThrow(/API_HOST/);
  });
});
