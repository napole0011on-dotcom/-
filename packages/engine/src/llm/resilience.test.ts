import { describe, expect, it } from 'vitest';
import { backoffMs } from './client.js';
import { describeProviderError, redactSecrets } from './transport.js';

describe('LLM resilience helpers', () => {
  it('backoff grows exponentially with ±25% jitter, is capped, Retry-After wins', () => {
    const r = { baseMs: 1000, maxMs: 8000 };
    expect(backoffMs(0, r, null, () => 0.5)).toBe(1000);
    expect(backoffMs(2, r, null, () => 0.5)).toBe(4000);
    expect(backoffMs(10, r, null, () => 0.5)).toBe(8000);
    expect(backoffMs(1, r, null, () => 0)).toBe(1500);
    expect(backoffMs(1, r, null, () => 1)).toBe(2500);
    expect(backoffMs(0, r, 12_000, () => 0.5)).toBe(12_000);
  });

  it('never keeps keys or bearer tokens', () => {
    expect(redactSecrets('key sk-ant-api03-abcdef123 and Bearer eyJhbGciOi.x.y api_key=zzz')).toBe(
      'key [redacted] and Bearer [redacted] api_key=[redacted]',
    );
  });

  it('describes provider errors in words', () => {
    expect(describeProviderError('tokenharbor', 502)).toBe(
      'Token Harbor вернул 502 (шлюз не получил ответ от модели)',
    );
    expect(describeProviderError('anthropic', 529)).toBe(
      'Anthropic вернул 529 (модель перегружена)',
    );
    expect(describeProviderError('tokenharbor', null)).toBe(
      'Token Harbor: нет соединения или таймаут',
    );
  });
});
