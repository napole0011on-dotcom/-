import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { PermanentError, TransientError, type LlmConfig } from '@cms/core';
import { RateLimiter } from './rate-limiter.js';

export type LlmRequest = MessageCreateParamsNonStreaming;
export type LlmResponse = BetaMessage;

/** The one method of the Anthropic SDK we depend on; a fake implements it in tests. */
export interface LlmTransport {
  create(
    params: LlmRequest,
    options: { timeout: number; signal?: AbortSignal },
  ): Promise<LlmResponse>;
}

export function createAnthropicTransport(config: LlmConfig): LlmTransport {
  if (!config.apiKey) throw new PermanentError('missing_api_key', 'ANTHROPIC_API_KEY is not set');
  // Retries are done by LlmClient (same backoff, logging and circuit breaker for every provider).
  const client = new Anthropic({
    apiKey: config.apiKey,
    maxRetries: 0,
    timeout: config.timeoutMs,
  });
  return {
    create: (params, options) => client.beta.messages.create(params, options),
  };
}

/**
 * Anthropic-compatible gateway (Token Harbor): the official SDK with another base URL.
 * The SDK's own retries are off (maxRetries: 0) because they would bypass the rate limiter;
 * every request goes through the limiter, and a 429 freezes the limiter for Retry-After.
 */
export function createGatewayTransport(
  config: LlmConfig,
  limiter: RateLimiter,
  /** Tests inject a fake fetch to inspect the exact HTTP requests the SDK makes. */
  fetchImpl?: typeof fetch,
): LlmTransport {
  if (!config.apiKey) throw new PermanentError('missing_api_key', 'TOKENHARBOR_API_KEY is not set');
  if (!config.baseUrl)
    throw new PermanentError('missing_base_url', 'TOKENHARBOR_BASE_URL is not set');
  const client = new Anthropic({
    baseURL: config.baseUrl,
    ...(config.authMode === 'bearer'
      ? { apiKey: null, authToken: config.apiKey }
      : { apiKey: config.apiKey }),
    maxRetries: 0,
    timeout: config.timeoutMs,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    async create(params, options) {
      await limiter.acquire(options.signal);
      try {
        // Plain /v1/messages (the beta method adds "?beta=true", which a gateway may not accept).
        // We never send beta-only fields to the gateway, so the shapes are compatible.
        const plain: Record<string, unknown> = { ...params };
        delete plain.betas;
        delete plain.fallbacks;
        const res = await client.messages.create(
          plain as unknown as Anthropic.MessageCreateParamsNonStreaming,
          options,
        );
        return res as unknown as LlmResponse;
      } catch (err) {
        const retryAfterMs = retryAfterMsOf(err);
        if (retryAfterMs !== null) limiter.pauseFor(retryAfterMs);
        throw err;
      }
    },
  };
}

/** Picks the transport for LLM_PROVIDER (mock is created by the caller: it lives in @cms/agents). */
export function createLlmTransport(config: LlmConfig): LlmTransport {
  if (config.provider === 'tokenharbor') {
    const limiter = new RateLimiter([
      { limit: config.rateLimit.perMinute, windowMs: 60_000 },
      { limit: config.rateLimit.perHour, windowMs: 3_600_000 },
    ]);
    return createGatewayTransport(config, limiter);
  }
  if (config.provider === 'anthropic') return createAnthropicTransport(config);
  throw new PermanentError(
    'no_real_transport',
    `LLM_PROVIDER=${config.provider} has no real transport`,
  );
}

export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  tokenharbor: 'Token Harbor',
  mock: 'mock',
};

/** What an HTTP status means, in words for the owner. */
const STATUS_MEANING: Record<number, string> = {
  408: 'таймаут запроса',
  409: 'конфликт запросов',
  429: 'лимит запросов',
  500: 'внутренняя ошибка сервера',
  502: 'шлюз не получил ответ от модели',
  503: 'сервис недоступен или перегружен',
  504: 'шлюз не дождался ответа модели',
  529: 'модель перегружена',
};

/** Keys, tokens and long secrets never reach logs or the database. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /(api[-_]?key|token|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1$2[redacted]',
    );
}

/** Facts about a failed HTTP call for logs and llm_calls: status, request id, body excerpt. */
export function errorFacts(err: unknown): {
  status: number | null;
  requestId: string | null;
  body: string | null;
} {
  if (!(err instanceof Anthropic.APIError)) return { status: null, requestId: null, body: null };
  const h = (err as { headers?: Headers | null }).headers;
  const requestId =
    (err as { requestID?: string | null }).requestID ??
    h?.get('request-id') ??
    h?.get('x-request-id') ??
    null;
  // The SDK puts the status in front of the message ("502 <html>..."): drop it, we keep it apart.
  const raw =
    err.error && typeof err.error === 'object'
      ? JSON.stringify(err.error)
      : (err.message ?? '').replace(/^\d{3}\s+/, '');
  const body = redactSecrets(
    raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 300);
  return {
    status: typeof err.status === 'number' ? err.status : null,
    requestId,
    body: body || null,
  };
}

/** "Token Harbor вернул 502 (шлюз не получил ответ от модели)". */
export function describeProviderError(provider: string, status: number | null): string {
  const who = PROVIDER_LABEL[provider] ?? provider;
  if (status === null) return `${who}: нет соединения или таймаут`;
  return `${who} вернул ${status}${STATUS_MEANING[status] ? ` (${STATUS_MEANING[status]})` : ''}`;
}

/** Retry-After (seconds or HTTP date) / retry-after-ms from any error response, in milliseconds. */
export function retryAfterMsOf(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const h = (err as { headers?: Headers | null }).headers;
  if (!h) return null;
  const ms = Number(h.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = h.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Maps SDK errors to our taxonomy once the SDK's own retries are exhausted:
 * transient -> the queue retries the job later; permanent -> the run fails now.
 */
export function classifyLlmError(
  err: unknown,
  provider = 'anthropic',
): TransientError | PermanentError {
  const facts = errorFacts(err);
  const human = describeProviderError(provider, facts.status);
  const extra = { ...facts, provider, userMessage: human };
  if (err instanceof Anthropic.APIUserAbortError) {
    return new TransientError(
      'llm_aborted',
      'LLM call aborted (timeout or shutdown)',
      {},
      { cause: err },
    );
  }
  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return new TransientError(
      'llm_network',
      `LLM network error: ${err.message}`,
      { ...extra },
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    const ms = retryAfterMsOf(err);
    return new TransientError(
      'llm_rate_limited',
      ms !== null
        ? `LLM rate limited (429), retry after ${Math.ceil(ms / 1000)}s`
        : 'LLM rate limited (429)',
      { ...extra, ...(ms !== null ? { retryAfterSeconds: Math.ceil(ms / 1000) } : {}) },
      { cause: err },
    );
  }
  if (err instanceof Anthropic.InternalServerError) {
    const ms = retryAfterMsOf(err);
    return new TransientError(
      'llm_server_error',
      `LLM server error ${err.status}${facts.requestId ? ` (request ${facts.requestId})` : ''}${facts.body ? `: ${facts.body.slice(0, 120)}` : ''}`,
      { ...extra, ...(ms !== null ? { retryAfterMs: ms } : {}) },
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIError) {
    const status: number | undefined = typeof err.status === 'number' ? err.status : undefined;
    if (
      status === 408 ||
      status === 409 ||
      status === 529 ||
      (status !== undefined && status >= 500)
    ) {
      const ms = retryAfterMsOf(err);
      return new TransientError(
        'llm_server_error',
        `LLM error ${status}${facts.body ? `: ${facts.body.slice(0, 120)}` : ''}`,
        { ...extra, ...(ms !== null ? { retryAfterMs: ms } : {}) },
        { cause: err },
      );
    }
    // 400 invalid request, 401 auth, 403 permission, 404 model not found, 413 too large...
    return new PermanentError(
      'llm_request_rejected',
      `LLM rejected the request (${status}): ${redactSecrets(err.message).slice(0, 300)}`,
      { ...extra },
      { cause: err },
    );
  }
  if (err instanceof TransientError || err instanceof PermanentError) return err;
  return new TransientError(
    'llm_unknown',
    `Unexpected LLM error: ${(err as Error)?.message ?? String(err)}`,
    {},
    { cause: err },
  );
}
