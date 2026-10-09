import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { TransientError } from '@cms/core';
import { llmConfig } from '../testkit.js';
import { RateLimiter, type Clock } from './rate-limiter.js';
import { classifyLlmError, createGatewayTransport, retryAfterMsOf } from './transport.js';

/** Fake clock: sleep() advances time instantly. */
function fakeClock(start = 1_000_000): Clock & { t: number; slept: number[] } {
  const c = {
    t: start,
    slept: [] as number[],
    now: () => c.t,
    sleep: (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
      return Promise.resolve();
    },
  };
  return c;
}

describe('RateLimiter', () => {
  it('lets 60 requests through per minute, the 61st waits for the oldest to leave the window', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(
      [
        { limit: 60, windowMs: 60_000 },
        { limit: 1800, windowMs: 3_600_000 },
      ],
      clock,
    );
    for (let i = 0; i < 60; i++) await rl.acquire();
    expect(clock.slept).toEqual([]);
    await rl.acquire();
    expect(clock.slept).toEqual([60_000]);
  });

  it('respects the hourly window too', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter(
      [
        { limit: 0, windowMs: 60_000 },
        { limit: 3, windowMs: 3_600_000 },
      ],
      clock,
    );
    for (let i = 0; i < 3; i++) await rl.acquire();
    await rl.acquire();
    expect(clock.slept).toEqual([3_600_000]);
  });

  it('a Retry-After pause blocks everyone until it ends', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 60, windowMs: 60_000 }], clock);
    rl.pauseFor(30_000);
    await rl.acquire();
    expect(clock.slept).toEqual([30_000]);
  });

  it('limits of 0 disable throttling', () => {
    expect(new RateLimiter([{ limit: 0, windowMs: 60_000 }]).enabled).toBe(false);
  });
});

const okBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5.5:free',
  content: [{ type: 'text', text: '{"ok":true}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

function fakeFetch(responses: Response[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    return Promise.resolve(responses.shift()!);
  };
  return { fn: fn, requests };
}

const gatewayConfig = (authMode: 'x-api-key' | 'bearer' = 'x-api-key') =>
  llmConfig({
    provider: 'tokenharbor',
    apiKey: 'th-secret',
    baseUrl: 'https://tokenharbor.ai',
    authMode,
    refusalFallback: false,
  });

const params = {
  model: 'claude-haiku-5.5:free',
  max_tokens: 100,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('Token Harbor gateway transport (official SDK, other base URL)', () => {
  it('POSTs to <base>/v1/messages with x-api-key', async () => {
    const f = fakeFetch([
      new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const t = createGatewayTransport(gatewayConfig(), new RateLimiter([]), f.fn);
    const res = await t.create(params, { timeout: 5000 });
    expect(res.model).toBe('claude-haiku-5.5:free');
    expect(f.requests[0]!.url).toBe('https://tokenharbor.ai/v1/messages');
    expect(f.requests[0]!.headers.get('x-api-key')).toBe('th-secret');
    expect(f.requests[0]!.headers.get('authorization')).toBeNull();
    expect(f.requests[0]!.body.model).toBe('claude-haiku-5.5:free');
  });

  it('bearer mode sends Authorization: Bearer instead', async () => {
    const f = fakeFetch([
      new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    await createGatewayTransport(gatewayConfig('bearer'), new RateLimiter([]), f.fn).create(
      params,
      { timeout: 5000 },
    );
    expect(f.requests[0]!.headers.get('authorization')).toBe('Bearer th-secret');
    expect(f.requests[0]!.headers.get('x-api-key')).toBeNull();
  });

  it('on 429 makes exactly one request (no SDK hammering), pauses the limiter for Retry-After, reports it', async () => {
    const f = fakeFetch([
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '42' },
        },
      ),
    ]);
    const clock = fakeClock();
    const limiter = new RateLimiter([{ limit: 60, windowMs: 60_000 }], clock);
    const err = await createGatewayTransport(gatewayConfig(), limiter, f.fn)
      .create(params, { timeout: 5000 })
      .catch((e: unknown) => e);
    expect(f.requests).toHaveLength(1);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(retryAfterMsOf(err)).toBe(42_000);
    expect(limiter.delayMs()).toBeGreaterThanOrEqual(41_000);
    const classified = classifyLlmError(err);
    expect(classified).toBeInstanceOf(TransientError);
    expect(classified.details).toMatchObject({ status: 429, retryAfterSeconds: 42 });
  });
});

describe('gateway request hygiene', () => {
  it('never sends beta-only fields or the ?beta=true query to the gateway', async () => {
    const f = fakeFetch([
      new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    await createGatewayTransport(gatewayConfig(), new RateLimiter([]), f.fn).create(
      { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never,
      { timeout: 5000 },
    );
    expect(f.requests[0]!.url).toBe('https://tokenharbor.ai/v1/messages');
    expect(f.requests[0]!.body).not.toHaveProperty('fallbacks');
    expect(f.requests[0]!.body).not.toHaveProperty('betas');
    expect(f.requests[0]!.headers.get('anthropic-beta')).toBeNull();
  });
});
