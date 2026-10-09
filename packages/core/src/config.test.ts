import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig, requirePanel } from './config.js';

const base = {
  POSTGRES_USER: 'app',
  POSTGRES_PASSWORD: 'pg-secret-value',
  POSTGRES_DB: 'app',
};

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('applies safe defaults: mock providers, dry run on, publishing off', () => {
    const c = loadConfig(base, '/repo');
    expect(c.providersMode).toBe('mock');
    expect(c.dryRun).toBe(true);
    expect(c.publishEnabled).toBe(false);
    expect(c.storage.driver).toBe('local');
    expect(c.db.port).toBe(5432);
  });

  it('names the missing required variable', () => {
    const err = errorOf(() => loadConfig({ POSTGRES_USER: 'app', POSTGRES_DB: 'app' }, '/repo'));
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^POSTGRES_PASSWORD: is required/);
    expect(err.message).toContain('POSTGRES_PASSWORD');
  });

  it('treats empty values copied from .env.example as missing', () => {
    const err = errorOf(() => loadConfig({ ...base, POSTGRES_PASSWORD: '' }, '/repo'));
    expect(err.problems[0]).toMatch(/^POSTGRES_PASSWORD: is required/);
  });

  it('requires S3 settings only when STORAGE_DRIVER=s3', () => {
    const err = errorOf(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' }, '/repo'));
    const names = err.problems.map((p) => p.split(':')[0]);
    expect(names).toEqual(['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
  });

  it('rejects invalid values with the variable name', () => {
    const err = errorOf(() => loadConfig({ ...base, API_PORT: 'abc', DRY_RUN: 'maybe' }, '/repo'));
    const names = err.problems.map((p) => p.split(':')[0]).sort();
    expect(names).toEqual(['API_PORT', 'DRY_RUN']);
  });

  it('refuses PUBLISH_ENABLED=true while DRY_RUN is on', () => {
    const err = errorOf(() => loadConfig({ ...base, PUBLISH_ENABLED: 'true' }, '/repo'));
    expect(err.problems[0]).toMatch(/^PUBLISH_ENABLED:/);
  });

  it('never echoes secret values in errors', () => {
    const err = errorOf(() =>
      loadConfig(
        {
          ...base,
          STORAGE_DRIVER: 's3',
          S3_SECRET_ACCESS_KEY: 's3-secret-value',
          S3_ENDPOINT: 'nope',
        },
        '/repo',
      ),
    );
    expect(err.message).not.toContain('s3-secret-value');
    expect(err.message).not.toContain('pg-secret-value');
    expect(err.message).toContain('S3_ENDPOINT');
  });

  it('describeConfig masks secrets', () => {
    const c = loadConfig(
      {
        ...base,
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://localhost:8333',
        S3_BUCKET: 'content',
        S3_ACCESS_KEY_ID: 'key-id-value',
        S3_SECRET_ACCESS_KEY: 's3-secret-value',
      },
      '/repo',
    );
    const text = JSON.stringify(describeConfig(c));
    for (const secret of ['pg-secret-value', 'key-id-value', 's3-secret-value']) {
      expect(text).not.toContain(secret);
    }
  });

  it('requires ANTHROPIC_API_KEY only in real mode and defaults models/budgets', () => {
    const c = loadConfig(base, '/repo');
    expect(c.llm.models).toEqual({
      ceo: 'claude-opus-5-5',
      critic: 'claude-opus-5-5',
      worker: 'claude-sonnet-5-5',
      classifier: 'claude-haiku-5-5',
    });
    expect(c.budget).toMatchObject({ dailyUsd: 5, monthlyUsd: 50, warnRatio: 0.8 });
    const err = errorOf(() => loadConfig({ ...base, LLM_PROVIDER: 'anthropic' }, '/repo'));
    expect(err.problems.map((p) => p.split(':')[0])).toContain('ANTHROPIC_API_KEY');
  });

  it('validates the time zone and masks the API key', () => {
    expect(
      errorOf(() => loadConfig({ ...base, APP_TIMEZONE: 'Mars/Base' }, '/repo')).problems[0],
    ).toMatch(/^APP_TIMEZONE:/);
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-secret-value' }, '/repo');
    expect(JSON.stringify(describeConfig(c))).not.toContain('sk-ant-secret-value');
  });

  it('telegram settings: optional for the API, required (with names) for the bot', async () => {
    const { requireTelegram } = await import('./config.js');
    const c = loadConfig(base, '/repo');
    const err = errorOf(() => requireTelegram(c));
    expect(err.problems.map((p) => p.split(':')[0])).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_OWNER_ID',
    ]);
    const ok = loadConfig(
      { ...base, TELEGRAM_BOT_TOKEN: '123:abc-secret', TELEGRAM_OWNER_ID: '42' },
      '/repo',
    );
    expect(requireTelegram(ok)).toEqual({ botToken: '123:abc-secret', ownerId: 42 });
    expect(JSON.stringify(describeConfig(ok))).not.toContain('abc-secret');
    expect(
      errorOf(() => loadConfig({ ...base, TELEGRAM_OWNER_ID: '@me' }, '/repo')).problems[0],
    ).toMatch(/^TELEGRAM_OWNER_ID:/);
  });

  describe('Token Harbor gateway', () => {
    const th = {
      ...base,
      LLM_PROVIDER: 'tokenharbor',
      TOKENHARBOR_API_KEY: 'th-secret-value',
      TOKENHARBOR_BASE_URL: 'https://tokenharbor.ai',
      LLM_MODEL_CEO: 'claude-haiku-5.5:free',
      LLM_REFUSAL_FALLBACK: 'true',
    };

    it('requires key and base URL, names both', () => {
      const err = errorOf(() => loadConfig({ ...base, LLM_PROVIDER: 'tokenharbor' }, '/repo'));
      expect(err.problems.map((p) => p.split(':')[0])).toEqual([
        'TOKENHARBOR_API_KEY',
        'TOKENHARBOR_BASE_URL',
      ]);
    });

    it('rejects a base URL ending in /v1 (the SDK appends /v1/messages)', () => {
      const err = errorOf(() =>
        loadConfig({ ...th, TOKENHARBOR_BASE_URL: 'https://tokenharbor.ai/v1' }, '/repo'),
      );
      expect(err.problems[0]).toMatch(/^TOKENHARBOR_BASE_URL: must not end with \/v1/);
    });

    it('maps the gateway settings, forces refusal fallback off, picks the gateway price list', () => {
      const c = loadConfig(th, '/repo');
      expect(c.llm).toMatchObject({
        provider: 'tokenharbor',
        apiKey: 'th-secret-value',
        baseUrl: 'https://tokenharbor.ai',
        authMode: 'x-api-key',
        refusalFallback: false,
        costSafetyFactor: 1.2,
      });
      expect(c.llm.models.ceo).toBe('claude-haiku-5.5:free');
      expect(c.llm.pricingFile.replace(/\\/g, '/')).toMatch(
        /config\/model-pricing\.tokenharbor\.json$/,
      );
      expect(loadConfig(base, '/repo').llm.pricingFile.replace(/\\/g, '/')).toMatch(
        /config\/model-pricing\.json$/,
      );
      expect(JSON.stringify(describeConfig(c))).not.toContain('th-secret-value');
    });

    it('rate limits and structured outputs are configurable', () => {
      const c = loadConfig(
        {
          ...th,
          LLM_RATE_LIMIT_PER_MINUTE: '60',
          LLM_RATE_LIMIT_PER_HOUR: '1800',
          LLM_STRUCTURED_OUTPUTS: 'false',
        },
        '/repo',
      );
      expect(c.llm.rateLimit).toEqual({ perMinute: 60, perHour: 1800 });
      expect(c.llm.structuredOutputs).toBe(false);
    });
  });

  it('panel: loopback-only host, session defaults, hash required only for the panel', () => {
    const c = loadConfig(base, '/repo');
    expect(c.api.host).toBe('127.0.0.1');
    expect(c.panel).toMatchObject({
      sessionIdleMinutes: 30,
      sessionMaxHours: 12,
      loginMaxAttempts: 5,
      loginLockMinutes: 5,
    });
    expect(errorOf(() => requirePanel(c)).message).toContain('pnpm panel:password');
    expect(errorOf(() => loadConfig({ ...base, API_HOST: '0.0.0.0' }, '/repo')).message).toContain(
      'API_HOST',
    );
    expect(
      errorOf(() => loadConfig({ ...base, PANEL_PASSWORD_HASH: 'plain-password' }, '/repo'))
        .message,
    ).toContain('PANEL_PASSWORD_HASH');
    const hash = 'scrypt:32768:8:1:c2FsdA==:aGFzaA==';
    const ok = loadConfig({ ...base, PANEL_PASSWORD_HASH: hash }, '/repo');
    expect(requirePanel(ok).passwordHash).toBe(hash);
    expect(JSON.stringify(describeConfig(ok))).not.toContain('aGFzaA==');
  });
});
