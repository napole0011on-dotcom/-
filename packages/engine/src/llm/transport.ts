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
  // The SDK already retries 408/409/429/5xx and connection errors with backoff.
  const client = new Anthropic({
    apiKey: config.apiKey,
    maxRetries: config.maxRetries,
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

/** Retry-After (seconds or HTTP date) / retry-after-ms from a 429 or 503, in milliseconds. */
export function retryAfterMsOf(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError) || !(err.status === 429 || err.status === 503))
    return null;
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
export function classifyLlmError(err: unknown): TransientError | PermanentError {
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
      {},
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
      { status: 429, ...(ms !== null ? { retryAfterSeconds: Math.ceil(ms / 1000) } : {}) },
      { cause: err },
    );
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new TransientError(
      'llm_server_error',
      `LLM server error ${err.status}`,
      { status: err.status },
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
      return new TransientError(
        'llm_server_error',
        `LLM error ${status}`,
        { status },
        { cause: err },
      );
    }
    // 400 invalid request, 401 auth, 403 permission, 404 model not found, 413 too large...
    return new PermanentError(
      'llm_request_rejected',
      `LLM rejected the request (${status}): ${err.message}`,
      { status },
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
