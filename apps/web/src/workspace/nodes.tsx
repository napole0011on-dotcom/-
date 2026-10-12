import { memo, type CSSProperties } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { TaskPathData, WorkspaceNodeData } from '../api';
import { agentVar, usd } from '../format';
import { Icon } from '../icons';

export type NodeState =
  | 'working'
  | 'waiting'
  | 'waiting_agent'
  | 'done'
  | 'error'
  | 'paused'
  | 'disabled'
  | 'idle'
  | 'pending'
  | 'planned'
  | 'draft';

export interface BoardNodeData extends Record<string, unknown> {
  node: WorkspaceNodeData;
  state: NodeState;
  /** One line under the title: what the agent does right now / for the selected task. */
  doing: string;
  dim: boolean;
  verdict: boolean | null;
  stepCost: number | null;
  waitingOwner: number;
}
export type BoardNode = Node<BoardNodeData>;

export interface BoardEdgeData extends Record<string, unknown> {
  color: string;
  flowing: boolean;
  active: boolean;
  dim: boolean;
  deletable: boolean;
  system: boolean;
  onDelete: () => void;
}
export type BoardEdge = Edge<BoardEdgeData>;

const STATE_LABEL: Record<NodeState, string> = {
  working: 'работает',
  waiting: 'ждёт вас',
  waiting_agent: 'ждёт агента',
  done: 'готово',
  error: 'ошибка',
  paused: 'пауза',
  disabled: 'выключен',
  idle: 'свободен',
  pending: 'не начат',
  planned: 'запланирован',
  draft: 'черновик',
};
const STATE_TONE: Record<NodeState, string> = {
  working: 'var(--agent)',
  waiting: 'var(--st-waiting)',
  waiting_agent: 'var(--st-waiting)',
  done: 'var(--st-done)',
  error: 'var(--st-error)',
  paused: 'var(--st-idle)',
  disabled: 'var(--st-idle)',
  idle: 'var(--st-idle)',
  pending: 'var(--st-idle)',
  planned: 'var(--st-idle)',
  draft: 'var(--st-idle)',
};

export function StatePill({ state }: { state: NodeState }) {
  return (
    <span
      className={`pill${state === 'working' ? ' live' : ''}`}
      style={{ '--tone': STATE_TONE[state] } as CSSProperties}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

export const AgentNode = memo(function AgentNode({ data }: NodeProps<BoardNode>) {
  const n = data.node;
  const inactive = n.status !== 'active';
  const cls = [
    'ws-node',
    n.kind === 'tool' ? 'tool' : '',
    inactive ? 'inactive' : '',
    data.dim ? 'dimmed' : '',
    data.state === 'error' ? 'error' : '',
    data.state === 'paused' || data.state === 'disabled' ? 'paused' : '',
  ].join(' ');
  const card = n.card;
  return (
    <div
      className={cls}
      style={{ '--agent': agentVar(n.color) } as CSSProperties}
      aria-label={`${n.name}: ${STATE_LABEL[data.state]}`}
    >
      <Handle type="target" position={Position.Left} className="ws-handle" />
      {data.verdict !== null && (
        <span
          className={`ws-node-verdict ${data.verdict ? 'ok' : 'bad'}`}
          title={data.verdict ? 'Critic: принято' : 'Critic: были замечания'}
        >
          {data.verdict ? '✓' : '✗'}
        </span>
      )}
      <div className="ws-node-head">
        <div className="avatar" aria-hidden>
          {n.icon}
        </div>
        <div className="title-block">
          <b className="clamp-1">{n.name}</b>
          <small className="clamp-1">{n.kind === 'tool' ? `инструмент · ${n.role}` : n.role}</small>
        </div>
      </div>
      <StatePill state={data.state} />
      <div className="ws-node-task clamp-1" title={data.doing}>
        {data.doing}
      </div>
      <div className="ws-node-metrics">
        <span>запусков {card?.runs30 ?? 0}</span>
        <span>{data.stepCost !== null ? usd(data.stepCost) : usd(card?.spentTodayUsd ?? 0)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="ws-handle source" />
    </div>
  );
});

export const HumanNode = memo(function HumanNode({ data }: NodeProps<BoardNode>) {
  const n = data.node;
  const isBrief = n.id === 'brief';
  return (
    <div className={`ws-node human ${data.dim ? 'dimmed' : ''}`} aria-label={n.name}>
      {!isBrief && <Handle type="target" position={Position.Left} className="ws-handle" />}
      <div className="ws-node-head">
        <div className="avatar human" aria-hidden>
          {n.icon}
        </div>
        <div className="title-block">
          <b>{n.name}</b>
          <small className="clamp-2">{n.role}</small>
        </div>
      </div>
      {!isBrief && data.waitingOwner > 0 && (
        <span className="pill pill-accent" style={{ marginTop: 9 }}>
          ждёт вас: {data.waitingOwner}
        </span>
      )}
      {isBrief && <Handle type="source" position={Position.Right} className="ws-handle source" />}
    </div>
  );
});

export const FlowEdge = memo(function FlowEdge(props: EdgeProps<BoardEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } =
    props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const d = data!;
  const cls = !d.active ? 'ws-edge-inactive' : d.dim ? 'ws-edge-dimmed' : '';
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className={cls}
        style={{
          stroke: selected ? 'var(--primary)' : d.dim ? 'var(--dot)' : 'var(--border-strong)',
        }}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        interactionWidth={18}
      />
      {d.flowing && !d.dim && (
        <path
          d={path}
          className="ws-edge-flow"
          fill="none"
          strokeWidth={2.2}
          style={{ stroke: d.color }}
        />
      )}
      {(selected || !d.active) && (
        <EdgeLabelRenderer>
          <div
            className="ws-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {selected ? (
              d.deletable ? (
                <button type="button" className="linklike danger" onClick={d.onDelete}>
                  <Icon name="trash" /> Удалить связь
                </button>
              ) : (
                <span>основной конвейер — удалить нельзя</span>
              )
            ) : (
              <span>не работает: агент не активен</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const nodeTypes = { agent: AgentNode, human: HumanNode };
export const edgeTypes = { flow: FlowEdge };

/** Status of a node on the board: demo > selected task > live card. */
export function nodeState(
  n: WorkspaceNodeData,
  opts: {
    demo: 'work' | 'done' | null;
    live: boolean;
    path: TaskPathData['nodes'][number] | null;
    taskSelected: boolean;
  },
): NodeState {
  if (n.status === 'planned') return 'planned';
  if (n.status === 'draft') return 'draft';
  if (opts.demo === 'work') return 'working';
  if (opts.demo === 'done') return 'done';
  if (opts.taskSelected) {
    if (!opts.path) return 'pending';
    return opts.path.state === 'running'
      ? 'working'
      : opts.path.state === 'waiting'
        ? 'waiting_agent'
        : opts.path.state === 'failed'
          ? 'error'
          : opts.path.state === 'done'
            ? 'done'
            : 'pending';
  }
  if (opts.live) return 'working';
  switch (n.card?.status) {
    case 'working':
      return 'working';
    case 'waiting_approval':
      return 'waiting';
    case 'error':
      return 'error';
    case 'paused':
      return 'paused';
    case 'disabled':
      return 'disabled';
    default:
      return 'idle';
  }
}

export { agentVar };
