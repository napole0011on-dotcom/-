import type { AgentContext, AgentResult } from './agents/context.js';
import type { CeoPlan } from './schemas.js';

/** Result of an upstream step passed to the next one (always as external data). */
export interface UpstreamResult {
  agent: string;
  name: string;
  items: unknown[];
}

export interface GenericIssue {
  problem: string;
  fix: string;
}

/** Critic verdict on a non-copy result (criteria come from the agent definition). */
export interface GenericVerdict {
  passed: boolean;
  summary: string;
  issues: GenericIssue[];
}

export interface NodeInput {
  brief: string;
  plan: CeoPlan;
  upstream: UpstreamResult[];
  /** Previous version when the owner asked for a revision / the Critic sent it back. */
  previous: unknown;
  ownerComment: string | null;
  criticIssues: GenericIssue[];
  mode: 'first' | 'revise' | 'regenerate';
  /** Distinguishes LLM calls inside one run (idempotency). */
  step: string;
}

/** How a result is shown to the owner (Telegram and panel), stored with the artifact. */
export interface NodeRender {
  title: string;
  lines: string[];
}

/** A file a step produced (image, document), kept in object storage under `key`. */
export interface NodeFile {
  name: string;
  key: string;
  mimeType: string;
}

/** A step of the graph other than the copywriter: code agent, constructor agent or tool. */
export interface NodeExecutor {
  run(ctx: AgentContext, input: NodeInput): Promise<AgentResult<unknown>>;
  render(output: unknown): NodeRender;
  /** Files of the result (shown in the panel, copied into the export folder). */
  files?(output: unknown): NodeFile[];
  /** Optional Critic review (used when the board has a link step -> Critic). */
  review?(
    ctx: AgentContext,
    input: NodeInput,
    output: unknown,
  ): Promise<AgentResult<GenericVerdict>>;
}

/** Content of a `node:<agent>:main` artifact. */
export interface NodeContent extends Record<string, unknown> {
  agent: string;
  name: string;
  output: unknown;
  render: NodeRender;
  /** Hash of the upstream results it was produced from (stale when upstream changes). */
  inputSig: string;
  critic: GenericVerdict | null;
  criticRound: number;
  criticRejected: boolean;
  ownerComment: string | null;
  files?: NodeFile[];
}

export const nodeSlot = (agent: string) => `node:${agent}:main`;
export const nodeSlotPrefix = (agent: string) => `node:${agent}:`;

const label = (k: string) => k.replace(/_/g, ' ');
const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Readable lines from any JSON result (fallback when the agent has no own renderer). */
export function renderGeneric(output: unknown, title = 'Результат'): NodeRender {
  const lines: string[] = [];
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (lines.length >= 40) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.slice(0, 10).forEach((x, i) =>
        typeof x === 'object' && x !== null
          ? walk(x, `${prefix}${prefix ? ' ' : ''}${i + 1}.`, depth + 1)
          : lines.push(`${prefix ? `${prefix}: ` : '• '}${str(x)}`),
      );
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'object' && x !== null && depth < 3)
          walk(x, `${prefix} ${label(k)}`.trim(), depth + 1);
        else if (x !== null && x !== undefined && x !== '')
          lines.push(`${`${prefix} ${label(k)}`.trim()}: ${str(x)}`);
      }
      return;
    }
    lines.push(`${prefix ? `${prefix}: ` : ''}${str(v)}`);
  };
  walk(output, '', 0);
  return { title, lines: lines.map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)) };
}
