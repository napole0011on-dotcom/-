/**
 * In-process sliding-window limiter for an LLM provider ("60 per minute and 1800 per hour").
 * Requests over the limit wait for a free slot instead of provoking 429s. A 429 with
 * Retry-After freezes all requests until that moment (`pauseFor`). One process runs the bot
 * and the worker, so in-memory state is enough.
 */
export interface RateWindow {
  limit: number;
  windowMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted)
        return reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export class RateLimiter {
  private readonly windows: RateWindow[];
  private readonly sent: number[] = [];
  private pausedUntil = 0;
  /** Serialises acquire() calls so waiting requests keep their order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    windows: RateWindow[],
    private readonly clock: Clock = systemClock,
  ) {
    this.windows = windows.filter((w) => w.limit > 0);
  }

  get enabled(): boolean {
    return this.windows.length > 0;
  }

  /** Called on 429: nobody sends anything until the provider says it is fine again. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  /** Resolves when a request may be sent (and records it). */
  acquire(signal?: AbortSignal): Promise<void> {
    const next = this.chain.then(() => this.waitForSlot(signal));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Milliseconds until a request could be sent now (0 = immediately). */
  delayMs(): number {
    const now = this.clock.now();
    let wait = Math.max(0, this.pausedUntil - now);
    const longest = Math.max(0, ...this.windows.map((w) => w.windowMs));
    while (this.sent.length > 0 && this.sent[0]! <= now - longest) this.sent.shift();
    for (const w of this.windows) {
      const inWindow = this.sent.filter((t) => t > now - w.windowMs);
      if (inWindow.length >= w.limit) {
        // The oldest request inside the window must leave it first.
        wait = Math.max(wait, inWindow[inWindow.length - w.limit]! + w.windowMs - now);
      }
    }
    return wait;
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const wait = this.delayMs();
      if (wait <= 0) {
        this.sent.push(this.clock.now());
        return;
      }
      await this.clock.sleep(wait, signal);
    }
  }
}
