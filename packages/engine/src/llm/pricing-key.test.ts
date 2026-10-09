import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, loadPricing, priceKeyForServedModel } from '@cms/core';
import { fakeResponse, pricing as anthropicPricing } from '../testkit.js';
import { costOfResponse } from './client.js';

const gw = loadPricing(path.join(findRepoRoot(), 'config', 'model-pricing.tokenharbor.json'));
const iteration = (
  type: 'message' | 'fallback_message',
  model: string | null,
  input: number,
  output: number,
) => ({
  type,
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: null,
});

describe('pricing key: requested model vs. model name in the response', () => {
  it('REPRO: free model requested, gateway answers "claude-haiku-5.5" (no :free) -> exactly $0, not estimated', () => {
    const res = fakeResponse('{}', { model: 'claude-haiku-5.5', input: 2400, output: 300 });
    expect(costOfResponse(gw, 'claude-haiku-5.5:free', res)).toMatchObject({
      usd: 0,
      estimated: false,
      servedMismatch: false,
    });
  });

  it('a paid request under the alias name is NOT priced as free: unknown -> most expensive, estimated', () => {
    const res = fakeResponse('{}', { model: 'claude-haiku-5.5', input: 1_000_000, output: 0 });
    expect(costOfResponse(gw, 'claude-haiku-5.5', res)).toMatchObject({ usd: 10, estimated: true });
  });

  it('an unknown requested model stays at the maximum price, estimated, whatever the response says', () => {
    const res = fakeResponse('{}', { model: 'claude-haiku-5.5:free', input: 0, output: 1_000_000 });
    expect(costOfResponse(gw, 'some-new-model', res)).toMatchObject({ usd: 50, estimated: true });
  });

  it('an unexpected served model is flagged, but the request is still priced as requested', () => {
    const res = fakeResponse('{}', { model: 'claude-opus-9', input: 1000, output: 1000 });
    expect(costOfResponse(gw, 'claude-haiku-5.5:free', res)).toMatchObject({
      usd: 0,
      servedMismatch: true,
    });
  });

  it('Anthropic refusal fallback: the fallback attempt is billed at its own model, the declined one at the requested', () => {
    const res = fakeResponse('{}', {
      model: 'claude-opus-4-8',
      iterations: [
        iteration('message', null, 1000, 100),
        iteration('fallback_message', 'claude-opus-4-8', 1000, 1000),
      ] as never,
    });
    // opus-5-5: 1000*$4 + 100*$20 ; opus-4-8: 1000*$5 + 1000*$25  (per 1M)
    expect(costOfResponse(anthropicPricing(), 'claude-opus-5-5', res)).toMatchObject({
      usd: 0.036,
      estimated: false,
    });
  });

  it('a fallback attempt on an unlisted model is priced at the maximum and marked estimated', () => {
    const res = fakeResponse('{}', {
      model: 'claude-mystery',
      iterations: [iteration('fallback_message', 'claude-mystery', 0, 1_000_000)] as never,
    });
    expect(costOfResponse(anthropicPricing(), 'claude-opus-5-5', res)).toMatchObject({
      usd: 50,
      estimated: true,
    });
  });

  it('priceKeyForServedModel resolves exact names and aliases only', () => {
    expect(priceKeyForServedModel(gw, 'claude-haiku-5.5:free')).toBe('claude-haiku-5.5:free');
    expect(priceKeyForServedModel(gw, 'claude-haiku-5.5')).toBe('claude-haiku-5.5:free');
    expect(priceKeyForServedModel(gw, 'claude-haiku')).toBeNull();
  });
});
