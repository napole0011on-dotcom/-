import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration. Every variable the system reads is declared here;
 * nothing else should touch `process.env` directly.
 */

const port = z.coerce.number().int().min(1).max(65535);
const bool = z.stringbool();
const requiredString = (hint: string) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `is required (${hint})` : undefined) })
    .min(1, {
      error: `must not be empty (${hint})`,
    });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    POSTGRES_HOST: z.string().min(1).default('localhost'),
    POSTGRES_PORT: port.default(5432),
    POSTGRES_USER: requiredString('PostgreSQL user, same value docker compose uses'),
    POSTGRES_PASSWORD: requiredString('PostgreSQL password, same value docker compose uses'),
    POSTGRES_DB: requiredString('PostgreSQL database name'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_DIR: z.string().min(1).default('data/storage'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),

    PROVIDERS_MODE: z.enum(['mock', 'real']).default('mock'),
    DRY_RUN: bool.default(true),
    PUBLISH_ENABLED: bool.default(false),

    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: port.default(3000),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of [
        'S3_ENDPOINT',
        'S3_BUCKET',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when STORAGE_DRIVER=s3',
          });
        }
      }
    }
    if (env.PUBLISH_ENABLED && env.DRY_RUN) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLISH_ENABLED'],
        message: 'cannot be true while DRY_RUN=true (turn DRY_RUN off explicitly to publish)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type StorageConfig =
  | { driver: 'local'; dir: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  db: { host: string; port: number; user: string; password: string; database: string };
  storage: StorageConfig;
  providersMode: Env['PROVIDERS_MODE'];
  dryRun: boolean;
  publishEnabled: boolean;
  api: { host: string; port: number };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid configuration. Fix these environment variables (see .env.example):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/** Parses and validates env. Throws ConfigError naming each bad variable; never echoes values. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  rootDir: string = findRepoRoot(),
): AppConfig {
  // Treat empty strings (e.g. `FOO=` copied from .env.example) as "not set".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join('.') : '(env)';
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  const storage: StorageConfig =
    e.STORAGE_DRIVER === 's3'
      ? {
          driver: 's3',
          // Presence of these is guaranteed by superRefine above.
          endpoint: e.S3_ENDPOINT!,
          region: e.S3_REGION,
          bucket: e.S3_BUCKET!,
          accessKeyId: e.S3_ACCESS_KEY_ID!,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          forcePathStyle: e.S3_FORCE_PATH_STYLE,
        }
      : { driver: 'local', dir: path.resolve(rootDir, e.LOCAL_STORAGE_DIR) };

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    db: {
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
      database: e.POSTGRES_DB,
    },
    storage,
    providersMode: e.PROVIDERS_MODE,
    dryRun: e.DRY_RUN,
    publishEnabled: e.PUBLISH_ENABLED,
    api: { host: e.API_HOST, port: e.API_PORT },
  };
}

/** Summary safe to log: secrets are replaced with a presence marker. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  const mask = (v: string) => (v ? '***set***' : '***missing***');
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    db: { ...config.db, password: mask(config.db.password) },
    storage:
      config.storage.driver === 's3'
        ? {
            ...config.storage,
            accessKeyId: mask(config.storage.accessKeyId),
            secretAccessKey: mask(config.storage.secretAccessKey),
          }
        : config.storage,
    providersMode: config.providersMode,
    dryRun: config.dryRun,
    publishEnabled: config.publishEnabled,
    api: config.api,
  };
}

/** Walks up from cwd to the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/**
 * Loads `<repoRoot>/.env` into process.env if it exists. Variables already set in the
 * real environment win over the file (Node's loadEnvFile semantics).
 */
export function loadDotEnv(rootDir: string = findRepoRoot()): void {
  const file = path.join(rootDir, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
