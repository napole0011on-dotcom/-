import { errorToJson, type Logger } from '@cms/core';
import type { Db, PgPool, PgPoolClient } from '@cms/db';
import { recentEvents } from '@cms/agents';

export type LiveEvent = Awaited<ReturnType<typeof recentEvents>>[number];
type Listener = (e: LiveEvent) => void;

/**
 * One LISTEN connection per API process. The bot (which runs the agents) inserts rows into
 * agent_events; a trigger NOTIFYs with the row id; the hub reads the new rows for the brand
 * and fans them out to the panel's SSE streams. Reconnects with back-off if the connection drops.
 */
export class EventHub {
  private listeners = new Set<Listener>();
  private client: PgPoolClient | null = null;
  private lastId = 0;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: PgPool,
    private readonly db: Db,
    private readonly brandId: () => string,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const [last] = await recentEvents(this.db, this.brandId(), 1);
    this.lastId = last?.id ?? 0;
    await this.connect();
  }

  private async connect(delayMs = 0): Promise<void> {
    if (this.stopped) return;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const client = await this.pool.connect();
      client.on('notification', () => this.pull());
      client.on('error', (err) => {
        this.logger.warn({ err: errorToJson(err) }, 'event hub connection lost');
        this.client = null;
        client.release(true);
        void this.connect(2000);
      });
      await client.query('LISTEN agent_events');
      this.client = client;
      this.pull(); // catch up on anything missed while disconnected
    } catch (err) {
      this.logger.warn({ err: errorToJson(err) }, 'event hub cannot listen, retrying');
      void this.connect(Math.min(30_000, Math.max(2000, delayMs * 2)));
    }
  }

  /** Serialised: reads rows after the last delivered id. */
  private pull() {
    this.pending = this.pending.then(async () => {
      try {
        const rows = await recentEvents(this.db, this.brandId(), 100, this.lastId);
        for (const e of rows.reverse()) {
          this.lastId = Math.max(this.lastId, e.id);
          for (const l of this.listeners) l(e);
        }
      } catch (err) {
        this.logger.warn({ err: errorToJson(err) }, 'event hub read failed');
      }
    });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** For tests: resolves after queued reads finished. */
  settle(): Promise<void> {
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.listeners.clear();
    if (this.client) {
      try {
        await this.client.query('UNLISTEN agent_events');
      } finally {
        this.client.release();
        this.client = null;
      }
    }
  }
}
