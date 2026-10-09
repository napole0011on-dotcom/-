import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration. Every variable the system reads is declared here;
 * nothing else should touch `process.env` directly.
 */

const port = z.coerce.number().int().min(1).max(65535);
const bool = z.stringbool();
const positiveInt = z.coerce.number().int().positive();
const usd = z.coerce.number().nonnegative();
const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { error: 'must be an IANA time zone, e.g. Europe/Moscow' },
);
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

    // Time zone used for "per day" / "per month" budgets and reminders.
    APP_TIMEZONE: timezone.default('Europe/Moscow'),

    // mock = canned answers, no API calls (default). anthropic = real Claude API.
    LLM_PROVIDER: z.enum(['mock', 'anthropic', 'tokenharbor']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Token Harbor gateway (Anthropic-compatible /v1/messages). Base URL without /v1: the SDK appends /v1/messages.
    TOKENHARBOR_API_KEY: z.string().min(1).optional(),
    TOKENHARBOR_BASE_URL: z
      .url()
      .refine((u) => !/\/v1\/?$/.test(u), {
        error: 'must not end with /v1 (the SDK adds /v1/messages itself)',
      })
      .optional(),
    TOKENHARBOR_AUTH: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
    // false = the JSON schema goes into the system prompt instead of output_config.format (Zod still validates).
    LLM_STRUCTURED_OUTPUTS: bool.default(true),
    // Client-side throttle (0 = off). Requests over the limit wait instead of hitting 429.
    LLM_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    LLM_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(0),
    // Multiplies reservations and recorded costs: budgets trip earlier if provider token counts drift.
    LLM_COST_SAFETY_FACTOR: z.coerce.number().min(1).max(5).default(1.2),
    LLM_MODEL_CEO: z.string().min(1).default('claude-opus-5-5'),
    LLM_MODEL_CRITIC: z.string().min(1).default('claude-opus-5-5'),
    LLM_MODEL_WORKER: z.string().min(1).default('claude-sonnet-5-5'),
    LLM_MODEL_CLASSIFIER: z.string().min(1).default('claude-haiku-5-5'),
    LLM_TIMEOUT_MS: positiveInt.default(180_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    LLM_STORE_FULL_TEXT: bool.default(true),
    LLM_REFUSAL_FALLBACK: bool.default(true),
    // Default depends on LLM_PROVIDER: config/model-pricing.json or config/model-pricing.tokenharbor.json.
    MODEL_PRICING_FILE: z.string().min(1).optional(),

    BUDGET_DAILY_USD: usd.default(5),
    BUDGET_MONTHLY_USD: usd.default(50),
    BUDGET_TASK_USD: usd.default(2),
    BUDGET_WARN_RATIO: z.coerce.number().gt(0).lt(1).default(0.8),

    QUEUE_RETRY_LIMIT: z.coerce.number().int().min(0).max(20).default(3),
    QUEUE_RETRY_DELAY_SECONDS: positiveInt.default(30),
    QUEUE_JOB_TIMEOUT_SECONDS: positiveInt.default(900),
    RUN_STALE_AFTER_SECONDS: positiveInt.default(900),
    APPROVAL_REMINDER_HOURS: positiveInt.default(12),

    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    // Only this Telegram user id may talk to the bot; everyone else is ignored.
    TELEGRAM_OWNER_ID: z.coerce.number().int().positive().optional(),

    BRAND_PROFILE_FILE: z.string().min(1).default('config/brands/default.yaml'),
    EXPORT_DIR: z.string().min(1).default('data/exports'),
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
    if (env.LLM_PROVIDER === 'tokenharbor') {
      for (const key of ['TOKENHARBOR_API_KEY', 'TOKENHARBOR_BASE_URL'] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when LLM_PROVIDER=tokenharbor',
          });
      }
    }
    if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'is required when LLM_PROVIDER=anthropic',
      });
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
  timezone: string;
  llm: LlmConfig;
  budget: BudgetConfig;
  queue: QueueConfig;
  approvalReminderHours: number;
  telegram: { botToken: string | undefined; ownerId: number | undefined };
  brandProfileFile: string;
  exportDir: string;
}

export interface LlmConfig {
  provider: 'mock' | 'anthropic' | 'tokenharbor';
  apiKey: string | undefined;
  models: { ceo: string; critic: string; worker: string; classifier: string };
  timeoutMs: number;
  maxRetries: number;
  storeFullText: boolean;
  refusalFallback: boolean;
  pricingFile: string;
  /** Base URL for the SDK; null = Anthropic's default. */
  baseUrl: string | null;
  authMode: 'x-api-key' | 'bearer';
  structuredOutputs: boolean;
  rateLimit: { perMinute: number; perHour: number };
  costSafetyFactor: number;
}

export interface BudgetConfig {
  dailyUsd: number;
  monthlyUsd: number;
  taskUsd: number;
  warnRatio: number;
}

export interface QueueConfig {
  retryLimit: number;
  retryDelaySeconds: number;
  jobTimeoutSeconds: number;
  runStaleAfterSeconds: number;
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
    timezone: e.APP_TIMEZONE,
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey: e.LLM_PROVIDER === 'tokenharbor' ? e.TOKENHARBOR_API_KEY : e.ANTHROPIC_API_KEY,
      baseUrl: e.LLM_PROVIDER === 'tokenharbor' ? e.TOKENHARBOR_BASE_URL! : null,
      authMode: e.LLM_PROVIDER === 'tokenharbor' ? e.TOKENHARBOR_AUTH : 'x-api-key',
      structuredOutputs: e.LLM_STRUCTURED_OUTPUTS,
      rateLimit: { perMinute: e.LLM_RATE_LIMIT_PER_MINUTE, perHour: e.LLM_RATE_LIMIT_PER_HOUR },
      costSafetyFactor: e.LLM_COST_SAFETY_FACTOR,
      models: {
        ceo: e.LLM_MODEL_CEO,
        critic: e.LLM_MODEL_CRITIC,
        worker: e.LLM_MODEL_WORKER,
        classifier: e.LLM_MODEL_CLASSIFIER,
      },
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
      storeFullText: e.LLM_STORE_FULL_TEXT,
      // Server-side refusal fallback is an Anthropic beta: always off behind a gateway.
      refusalFallback: e.LLM_PROVIDER === 'anthropic' && e.LLM_REFUSAL_FALLBACK,
      pricingFile: path.resolve(
        rootDir,
        e.MODEL_PRICING_FILE ??
          (e.LLM_PROVIDER === 'tokenharbor'
            ? 'config/model-pricing.tokenharbor.json'
            : 'config/model-pricing.json'),
      ),
    },
    budget: {
      dailyUsd: e.BUDGET_DAILY_USD,
      monthlyUsd: e.BUDGET_MONTHLY_USD,
      taskUsd: e.BUDGET_TASK_USD,
      warnRatio: e.BUDGET_WARN_RATIO,
    },
    queue: {
      retryLimit: e.QUEUE_RETRY_LIMIT,
      retryDelaySeconds: e.QUEUE_RETRY_DELAY_SECONDS,
      jobTimeoutSeconds: e.QUEUE_JOB_TIMEOUT_SECONDS,
      runStaleAfterSeconds: e.RUN_STALE_AFTER_SECONDS,
    },
    approvalReminderHours: e.APPROVAL_REMINDER_HOURS,
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, ownerId: e.TELEGRAM_OWNER_ID },
    brandProfileFile: path.resolve(rootDir, e.BRAND_PROFILE_FILE),
    exportDir: path.resolve(rootDir, e.EXPORT_DIR),
  };
}

/** The bot cannot start without these; reported like any other config error. */
export function requireTelegram(config: AppConfig): { botToken: string; ownerId: number } {
  const problems: string[] = [];
  if (!config.telegram.botToken)
    problems.push('TELEGRAM_BOT_TOKEN: is required to run the bot (token from @BotFather)');
  if (!config.telegram.ownerId)
    problems.push('TELEGRAM_OWNER_ID: is required to run the bot (your numeric Telegram user id)');
  if (problems.length > 0) throw new ConfigError(problems);
  return { botToken: config.telegram.botToken!, ownerId: config.telegram.ownerId! };
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
    timezone: config.timezone,
    llm: { ...config.llm, apiKey: config.llm.apiKey ? '***set***' : '***missing***' },
    budget: config.budget,
    queue: config.queue,
    approvalReminderHours: config.approvalReminderHours,
    telegram: {
      botToken: config.telegram.botToken ? '***set***' : '***missing***',
      ownerId: config.telegram.ownerId ? '***set***' : '***missing***',
    },
    brandProfileFile: config.brandProfileFile,
    exportDir: config.exportDir,
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
