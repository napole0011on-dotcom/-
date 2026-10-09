import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Keys whose values must never reach logs. pino redaction works on paths, so we list
 * the key at the top level and one/two levels deep (the shapes we actually log).
 */
const SECRET_KEYS = [
  'password',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'secretAccessKey',
  'accessKeyId',
  'authorization',
  'cookie',
  'connectionString',
  'botToken',
  'passwordHash',
  'csrfToken',
];

export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]).concat([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
]);

export interface CreateLoggerOptions {
  level?: LoggerOptions['level'];
  name?: string;
  /** For tests: capture output instead of writing to stdout. */
  destination?: DestinationStream;
}

/** Structured JSON logger. Correlation ids (taskId, runId) are added via `logger.child({...})`. */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    base: { service: opts.name ?? 'app' },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
