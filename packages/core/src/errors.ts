/**
 * Error taxonomy. `retryable` decides whether the queue retries the job:
 *  - TransientError: network, timeouts, 429, 5xx, lock contention -> retry with backoff.
 *  - PermanentError: bad request, auth, refusal, invalid output after retries -> fail now.
 *  - BudgetExceededError: not retried; the task is paused until a human approves more budget.
 */
export abstract class AppError extends Error {
  abstract readonly retryable: boolean;
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TransientError extends AppError {
  readonly retryable = true;
}

export class PermanentError extends AppError {
  readonly retryable = false;
}

export type BudgetScope = 'task' | 'day' | 'month';

export class BudgetExceededError extends AppError {
  readonly retryable = false;
  constructor(
    public readonly scope: BudgetScope,
    public readonly limitUsd: number,
    public readonly spentUsd: number,
    public readonly requestedUsd: number,
  ) {
    super(
      'budget_exceeded',
      `Budget exceeded for ${scope}: spent ${spentUsd.toFixed(4)} + requested ${requestedUsd.toFixed(4)} > limit ${limitUsd.toFixed(4)} USD`,
      { scope, limitUsd, spentUsd, requestedUsd },
    );
  }
}

export class InvalidTransitionError extends PermanentError {
  constructor(from: string, to: string, reason: string) {
    super('invalid_transition', `Transition ${from} -> ${to} is not allowed: ${reason}`, {
      from,
      to,
    });
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AppError) return err.retryable;
  // Unknown errors (bugs, driver errors) are retried a limited number of times by the queue.
  return true;
}

export function errorToJson(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      details: err.details,
    };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
