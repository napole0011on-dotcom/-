import { randomUUID } from 'node:crypto';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import {
  PermanentError,
  computeLlmCost,
  priceKeyForServedModel,
  errorToJson,
  estimateMaxLlmCost,
  type LlmConfig,
  type Logger,
  type ModelPricing,
} from '@cms/core';
import { schema, type DbOrTx } from '@cms/db';
import type { Notifier } from '@cms/providers';
import {
  checkBudgetWarnings,
  finalizeCost,
  releaseCost,
  reserveCost,
  type BudgetContext,
} from '../budget.js';
import { withIdempotency } from '../idempotency.js';
import {
  classifyLlmError,
  type LlmRequest,
  type LlmResponse,
  type LlmTransport,
} from './transport.js';

const { llmCalls } = schema;

/** A response that fails schema validation is retried at most this many times. */
export const MAX_SCHEMA_RETRIES = 2;

/** Models that accept `fallbacks: "default"` (server-side refusal fallback). */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface SystemBlock {
  text: string;
  /** Static parts (agent instructions, brand profile) are cached; volatile ones are not. */
  cache?: boolean;
}

export interface LlmCallContext {
  brandId: string;
  taskId: string | null;
  runId: string | null;
  agent: string;
  /** e.g. "copywriter@3" — stored with every call and artifact. */
  promptVersion: string;
}

export interface StructuredCallInput<T> {
  ctx: LlmCallContext;
  model: string;
  system: SystemBlock[];
  /** User turn. External data must already be wrapped with wrapExternalData(). */
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Same key => the call is made once; replays return the stored output without spending. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface StructuredCallResult<T> {
  output: T;
  requestedModel: string;
  servedModel: string;
  /** Cost counted against budgets (token cost x LLM_COST_SAFETY_FACTOR). */
  costUsd: number;
  /** Token cost from the price list, without the safety factor. */
  rawCostUsd: number;
  attempts: number;
  replayed: boolean;
}

export interface LlmClientDeps {
  db: DbOrTx;
  transport: LlmTransport;
  pricing: ModelPricing;
  config: LlmConfig;
  budget: BudgetContext;
  notifier: Notifier;
  logger: Logger;
}

/** Rough upper bound for prompt tokens (Cyrillic averages ~2-3 chars/token). */
export function estimatePromptTokens(texts: string[]): number {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return Math.ceil(chars / 2) + 50;
}

/**
 * Prices a response by the model we REQUESTED — that is the model we chose and know the
 * price of. The name in the response can differ (a gateway may drop a ":free" suffix), so it
 * is never used as the price key for our own request.
 *
 * Exception: with Anthropic's server-side refusal fallback, `usage.iterations` contains
 * `fallback_message` attempts that really ran on another model; those are billed at that
 * model's price (resolved through aliases; unknown -> most expensive, estimated).
 * Top-level usage covers only the final attempt, so iterations win when present.
 */
export function costOfResponse(pricing: ModelPricing, requestedModel: string, res: LlmResponse) {
  const attempts =
    res.usage.iterations && res.usage.iterations.length > 0
      ? res.usage.iterations.map((it) => ({
          priceKey:
            it.type === 'fallback_message' && 'model' in it && it.model
              ? (priceKeyForServedModel(pricing, it.model) ?? it.model)
              : requestedModel,
          input: it.input_tokens,
          output: it.output_tokens,
          cacheRead: it.cache_read_input_tokens ?? 0,
          cacheCreation: it.cache_creation_input_tokens ?? 0,
          cache1h: it.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        }))
      : [
          {
            priceKey: requestedModel,
            input: res.usage.input_tokens,
            output: res.usage.output_tokens,
            cacheRead: res.usage.cache_read_input_tokens ?? 0,
            cacheCreation: res.usage.cache_creation_input_tokens ?? 0,
            cache1h: res.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          },
        ];

  let usd = 0;
  let estimated = false;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const a of attempts) {
    const c = computeLlmCost(pricing, a.priceKey, {
      inputTokens: a.input,
      outputTokens: a.output,
      cacheReadTokens: a.cacheRead,
      cacheWrite1hTokens: a.cache1h,
      cacheWrite5mTokens: Math.max(0, a.cacheCreation - a.cache1h),
    });
    usd += c.usd;
    estimated ||= c.estimated;
    totals.input += a.input;
    totals.output += a.output;
    totals.cacheRead += a.cacheRead;
    totals.cacheWrite += a.cacheCreation;
  }
  // The served name is only checked for consistency: same model, or a known alias of it.
  const servedKey = res.model ? priceKeyForServedModel(pricing, res.model) : requestedModel;
  const servedMismatch =
    Boolean(res.model) && res.model !== requestedModel && servedKey !== requestedModel;
  return { usd: Math.round(usd * 1e8) / 1e8, estimated, totals, servedMismatch };
}

function textOf(res: LlmResponse): string {
  return res.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Without structured outputs models sometimes wrap JSON in ```json fences or add a line of
 * text around it. Take the outermost {...} object; Zod decides whether it is valid.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced.trim());
      } catch {
        // fall through to brace extraction
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('no JSON object found in the answer');
  }
}

/** System block that replaces output_config.format when the provider has no structured outputs. */
export function schemaInstruction(schema: z.ZodType): string {
  const json = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
  return [
    'Формат ответа: верни ровно один JSON-объект, который соответствует этой JSON Schema.',
    'Без пояснений, без markdown, без ``` — только JSON.',
    json,
  ].join('\n');
}

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

function validationFeedback(issues: string): string {
  return [
    'Your previous answer did not pass validation:',
    issues,
    'Return the complete corrected answer as JSON that matches the schema exactly. Do not add commentary.',
  ].join('\n');
}

export class LlmClient {
  constructor(private readonly deps: LlmClientDeps) {}

  async callStructured<T>(input: StructuredCallInput<T>): Promise<StructuredCallResult<T>> {
    const { result, replayed } = await withIdempotency(
      this.deps.db,
      `llm:${input.idempotencyKey}`,
      () => this.execute(input),
      {
        leaseSeconds:
          Math.ceil(this.deps.config.timeoutMs / 1000) * (this.deps.config.maxRetries + 1) * 3 + 60,
      },
    );
    if (replayed) {
      // Stored JSON came from a successful, validated call; re-validate defensively.
      const output = input.schema.parse(result.output);
      return { ...result, output, replayed: true };
    }
    return { ...result, replayed: false };
  }

  private async execute<T>(input: StructuredCallInput<T>): Promise<StructuredCallResult<T>> {
    const { ctx } = input;
    const log = this.deps.logger.child({ taskId: ctx.taskId, runId: ctx.runId, agent: ctx.agent });
    const maxTokens = input.maxTokens ?? 16_000;
    const format = zodOutputFormat(input.schema);

    const structured = this.deps.config.structuredOutputs;
    const factor = this.deps.config.costSafetyFactor;
    const system: BetaTextBlockParam[] = input.system.map((b) =>
      b.cache
        ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: b.text },
    );
    // Not cached: per-call schemas (e.g. deliverable ids) differ between calls.
    if (!structured) system.push({ type: 'text', text: schemaInstruction(input.schema) });
    const messages: BetaMessageParam[] = [{ role: 'user', content: input.prompt }];
    const useFallback = this.deps.config.refusalFallback && FALLBACK_MODELS.has(input.model);

    let totalCost = 0;
    for (let attempt = 1; attempt <= MAX_SCHEMA_RETRIES + 1; attempt++) {
      const params: LlmRequest = {
        model: input.model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(structured || input.effort
          ? {
              output_config: {
                ...(structured ? { format: { type: format.type, schema: format.schema } } : {}),
                ...(input.effort ? { effort: input.effort } : {}),
              },
            }
          : {}),
        ...(useFallback ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
      };

      const estimate = estimateMaxLlmCost(
        this.deps.pricing,
        input.model,
        estimatePromptTokens([
          ...system.map((s) => s.text),
          ...messages.map((m) => JSON.stringify(m.content)),
        ]),
        maxTokens,
      );
      // Throws BudgetExceededError before any money is spent.
      const reservation = await reserveCost(this.deps.db, this.deps.budget, {
        brandId: ctx.brandId,
        taskId: ctx.taskId,
        runId: ctx.runId,
        agent: ctx.agent,
        kind: 'llm',
        provider: this.deps.config.provider,
        model: input.model,
        estimateUsd: round8(estimate * factor),
        idempotencyKey: `cost:${input.idempotencyKey}:a${attempt}:${randomUUID()}`,
      });

      const started = Date.now();
      let res: LlmResponse;
      try {
        res = await this.deps.transport.create(params, {
          timeout: this.deps.config.timeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        const classified = classifyLlmError(err);
        await releaseCost(this.deps.db, reservation.id);
        await this.record(input, attempt, params, null, {
          status: 'error',
          latencyMs: Date.now() - started,
          error: errorToJson(classified),
        });
        log.warn({ attempt, err: errorToJson(classified) }, 'llm call failed');
        throw classified;
      }
      const latencyMs = Date.now() - started;

      const cost = costOfResponse(this.deps.pricing, input.model, res);
      if (cost.servedMismatch) {
        log.warn(
          { requestedModel: input.model, servedModel: res.model },
          'provider served a different model than requested (not a known alias); priced as requested',
        );
      }
      totalCost += cost.usd;
      await finalizeCost(this.deps.db, reservation.id, {
        costUsd: round8(cost.usd * factor),
        rawCostUsd: cost.usd,
        // The model the price was taken from (= requested); the served name stays in llm_calls.
        model: input.model,
        estimated: cost.estimated,
        inputTokens: cost.totals.input,
        outputTokens: cost.totals.output,
        cacheReadTokens: cost.totals.cacheRead,
        cacheWriteTokens: cost.totals.cacheWrite,
      });
      await checkBudgetWarnings(
        this.deps.db,
        this.deps.budget,
        this.deps.notifier,
        ctx.brandId,
        ctx.taskId,
        log,
      );

      const base = {
        latencyMs,
        costUsd: cost.usd,
        servedModel: res.model,
        stopReason: res.stop_reason,
        totals: cost.totals,
      };

      if (res.stop_reason === 'refusal') {
        await this.record(input, attempt, params, res, { ...base, status: 'refused' });
        throw new PermanentError('llm_refusal', 'The model declined the request', {
          category: res.stop_details?.category ?? null,
          explanation: res.stop_details?.explanation ?? null,
        });
      }

      const text = textOf(res);
      let issues: string | null = null;
      let output: T | undefined;
      if (res.stop_reason === 'max_tokens') {
        issues = `- the answer was cut off at max_tokens=${maxTokens}; make it shorter`;
      } else {
        try {
          const parsed = input.schema.safeParse(extractJson(text));
          if (parsed.success) output = parsed.data;
          else
            issues = parsed.error.issues
              .slice(0, 10)
              .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('\n');
        } catch (e) {
          issues = `- not valid JSON: ${(e as Error).message}`;
        }
      }

      if (output !== undefined) {
        await this.record(input, attempt, params, res, { ...base, status: 'ok' });
        log.info({ attempt, model: res.model, costUsd: cost.usd, latencyMs }, 'llm call ok');
        return {
          output,
          requestedModel: input.model,
          servedModel: res.model,
          costUsd: round8(totalCost * factor),
          rawCostUsd: round8(totalCost),
          attempts: attempt,
          replayed: false,
        };
      }

      await this.record(input, attempt, params, res, {
        ...base,
        status: 'invalid_output',
        error: { issues },
      });
      log.warn({ attempt, issues }, 'llm output failed validation');
      if (attempt > MAX_SCHEMA_RETRIES) {
        throw new PermanentError(
          'llm_invalid_output',
          `LLM output failed validation after ${attempt} attempts`,
          {
            issues,
          },
        );
      }
      // Append-only conversation: keep the model's answer, then ask for a fix.
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: validationFeedback(issues!) });
    }
    throw new Error('unreachable');
  }

  private async record(
    input: StructuredCallInput<unknown>,
    attempt: number,
    request: LlmRequest,
    response: LlmResponse | null,
    r: {
      status: string;
      latencyMs: number;
      costUsd?: number;
      servedModel?: string;
      stopReason?: string | null;
      totals?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      error?: unknown;
    },
  ): Promise<void> {
    const full = this.deps.config.storeFullText;
    await this.deps.db.insert(llmCalls).values({
      brandId: input.ctx.brandId,
      taskId: input.ctx.taskId,
      runId: input.ctx.runId,
      agent: input.ctx.agent,
      promptVersion: input.ctx.promptVersion,
      requestedModel: input.model,
      servedModel: r.servedModel ?? null,
      attempt,
      status: r.status,
      stopReason: r.stopReason ?? null,
      request: full ? request : null,
      response: full && response ? response : null,
      error: r.error ?? null,
      inputTokens: r.totals?.input ?? 0,
      outputTokens: r.totals?.output ?? 0,
      cacheReadTokens: r.totals?.cacheRead ?? 0,
      cacheWriteTokens: r.totals?.cacheWrite ?? 0,
      costUsd: (r.costUsd ?? 0).toFixed(8),
      latencyMs: r.latencyMs,
    });
  }
}
