import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { PermanentError, TransientError, type LlmConfig } from '@cms/core';

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
    return new TransientError(
      'llm_rate_limited',
      'LLM rate limited (429)',
      { status: 429 },
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
