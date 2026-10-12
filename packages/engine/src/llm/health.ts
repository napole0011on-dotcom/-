import { TransientError, type Logger } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';
import { PROVIDER_LABEL } from './transport.js';

const { providerStatus } = schema;

export type ProviderState = 'ok' | 'degraded' | 'down';

/**
 * The provider is marked down (circuit breaker open): the call is not made, the run waits in
 * the queue (no attempt spent) and is retried after `retryInSeconds`.
 */
export class ProviderUnavailableError extends TransientError {
  constructor(provider: string, retryInSeconds: number, lastError: unknown = null) {
    super(
      'provider_unavailable',
      `${PROVIDER_LABEL[provider] ?? provider} недоступен, повтор через ${retryInSeconds} с`,
      { provider, retryInSeconds, lastError },
    );
  }
}

export interface ProviderHealthView {
  provider: string;
  state: ProviderState;
  consecutiveFailures: number;
  lastError: Record<string, unknown> | null;
  lastErrorAt: Date | null;
  lastOkAt: Date | null;
  /** Seconds until the next try while down. */
  retryInSeconds: number | null;
}

/**
 * Circuit breaker per provider. State lives in `provider_status`, so the bot (worker) and the
 * API (header, "Проверить провайдера") see the same thing:
 *  - transient error -> failures + 1 (degraded); at `threshold` in a row -> down for `cooldown`;
 *  - while down, calls fail fast with ProviderUnavailableError (no request to the provider);
 *  - after the cooldown one call is let through (half-open); success -> ok, failure -> down again.
 */
export class ProviderHealth {
  /** One half-open probe at a time inside this process. */
  private probing = false;

  constructor(
    private readonly db: DbOrTx,
    readonly provider: string,
    private readonly opts: { threshold: number; cooldownSeconds: number },
    private readonly logger?: Logger,
  ) {}

  async view(): Promise<ProviderHealthView> {
    const [r] = await this.db
      .select()
      .from(providerStatus)
      .where(sql`${providerStatus.provider} = ${this.provider}`);
    const retryIn =
      r?.state === 'down' && r.openUntil
        ? Math.max(0, Math.ceil((r.openUntil.getTime() - Date.now()) / 1000))
        : null;
    return {
      provider: this.provider,
      state: (r?.state as ProviderState) ?? 'ok',
      consecutiveFailures: r?.consecutiveFailures ?? 0,
      lastError: (r?.lastError as Record<string, unknown>) ?? null,
      lastErrorAt: r?.lastErrorAt ?? null,
      lastOkAt: r?.lastOkAt ?? null,
      retryInSeconds: retryIn,
    };
  }

  /** Throws ProviderUnavailableError while the breaker is open; lets one probe through after it. */
  async before(): Promise<{ probe: boolean }> {
    const v = await this.view();
    if (v.state !== 'down') return { probe: false };
    if ((v.retryInSeconds ?? 0) > 0)
      throw new ProviderUnavailableError(this.provider, v.retryInSeconds!, v.lastError);
    if (this.probing)
      throw new ProviderUnavailableError(this.provider, this.opts.cooldownSeconds, v.lastError);
    this.probing = true;
    return { probe: true };
  }

  async success(): Promise<boolean> {
    this.probing = false;
    const before = await this.view();
    await this.db
      .insert(providerStatus)
      .values({
        provider: this.provider,
        state: 'ok',
        consecutiveFailures: 0,
        lastOkAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providerStatus.provider,
        set: {
          state: 'ok',
          consecutiveFailures: 0,
          openUntil: null,
          lastOkAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    const recovered = before.state === 'down';
    if (recovered) this.logger?.info({ provider: this.provider }, 'provider is back');
    return recovered;
  }

  /** Counts a transient failure; returns true when the breaker opened now. */
  async failure(error: Record<string, unknown>, forceOpen = false): Promise<boolean> {
    this.probing = false;
    const v = await this.view();
    const n = v.consecutiveFailures + 1;
    const open = forceOpen || n >= this.opts.threshold || v.state === 'down';
    const openUntil = open ? new Date(Date.now() + this.opts.cooldownSeconds * 1000) : null;
    const set = {
      state: open ? 'down' : 'degraded',
      consecutiveFailures: n,
      lastError: error,
      lastErrorAt: new Date(),
      openUntil,
    };
    await this.db
      .insert(providerStatus)
      .values({ provider: this.provider, ...set })
      .onConflictDoUpdate({
        target: providerStatus.provider,
        set: { ...set, updatedAt: sql`now()` },
      });
    if (open && v.state !== 'down')
      this.logger?.warn(
        { provider: this.provider, failures: n, cooldownSeconds: this.opts.cooldownSeconds },
        'provider marked down (circuit breaker open)',
      );
    return open && v.state !== 'down';
  }
}
