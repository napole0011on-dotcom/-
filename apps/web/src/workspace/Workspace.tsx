import '@xyflow/react/dist/style.css';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import {
  BRIEF,
  OWNER,
  TEAM_ROLE_LABEL,
  buildPipeline,
  validateLink,
  type GraphNode,
} from '@cms/agents/graph';
import { api, type LiveEvent, type WorkspaceData, type WorkspaceLinkData } from '../api';
import { STATUS_LABEL, usd } from '../format';
import { Icon } from '../icons';
import { useLiveEvents } from '../live';
import {
  useApprovals,
  useEvents,
  useStatus,
  useLibrary,
  useRunEvents,
  useTaskPath,
  useTasks,
  useWorkspace,
} from '../queries';
import { navigate } from '../router';
import { Button, Empty, ErrorBox, Link, Loading, Modal, Pill, useAction, useToast } from '../ui';
import { AgentDrawer, PauseButton, type DrawerTab } from '../components/AgentDrawer';
import {
  StatePill,
  agentVar,
  edgeTypes,
  nodeState,
  nodeTypes,
  type BoardEdge,
  type BoardNode,
} from './nodes';
import { demoScript, type DemoFrame } from './demo';
import { replayFrames } from './replay';
import { Library, TEMPLATE_DND, type AddTab } from './Library';
import { DeleteAgentDialog } from '../components/DeleteAgentDialog';

/** Below this the output points get too small to catch: the board scrolls instead. */
const MIN_READABLE_ZOOM = 0.55;

type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

function graphNodes(ws: WorkspaceData): GraphNode[] {
  // Roles and capabilities decide which links are allowed: the same check as on the server.
  return ws.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    status: n.status,
    teamRole: n.teamRole,
    capability: n.capability,
  }));
}

export function Workspace() {
  return (
    <ReactFlowProvider>
      <WorkspaceInner />
    </ReactFlowProvider>
  );
}

function WorkspaceInner() {
  const qc = useQueryClient();
  const toast = useToast();
  const rf = useReactFlow();
  const { data, error, isLoading, dataUpdatedAt } = useWorkspace();
  const { data: status } = useStatus();
  const { data: approvals } = useApprovals();
  const { data: tasks } = useTasks();
  // Agents reported working by live events (agent -> time of the "started" event).
  const [started, setStarted] = useState<Record<string, number>>({});
  const mode = useLiveEvents((e) => {
    setStarted((prev) => {
      const next = { ...prev };
      if (e.kind === 'started') next[e.agent] = Date.parse(e.at);
      if (e.kind === 'finished' || e.kind === 'failed') delete next[e.agent];
      return next;
    });
  });
  const { data: events } = useEvents(mode === 'polling' ? 3000 : false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const { data: path } = useTaskPath(taskId);
  const { data: runEvents } = useRunEvents(taskId);
  // «Повтор»: the selected task's events played back on the board (index into the frames).
  const [replay, setReplay] = useState<{ i: number; playing: boolean; speed: 1 | 4 } | null>(null);
  const [demo, setDemo] = useState<DemoFrame | null>(null);
  const [demoFeed, setDemoFeed] = useState<LiveEvent[]>([]);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [confirmLink, setConfirmLink] = useState<WorkspaceLinkData | null>(null);
  const [confirmAgent, setConfirmAgent] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardNode>([]);
  // Linking by clicks: the card whose output point was clicked (then click the receiver).
  const [linkFrom, setLinkFrom] = useState<string | null>(null);

  /**
   * «Вписать»: the whole board if it fits at a readable zoom; otherwise the readable zoom from
   * the left edge (Бриф → CEO first) and the rest is reached by scrolling.
   */
  const fitBoard = useCallback(
    (duration = 200) => {
      const ns = rf.getNodes();
      const el = document.querySelector<HTMLElement>('.ws-board .react-flow');
      if (!ns.length || !el) return;
      const b = getNodesBounds(ns);
      const pad = 24;
      // Cards never go under the zoom buttons (top right) or the minimap (bottom right).
      const right = pad;
      const bottom = pad + (el.querySelector('.react-flow__minimap') ? 100 : 0);
      const w = el.clientWidth - pad - right;
      const h = el.clientHeight - pad - bottom;
      const fit = Math.min(1, w / b.width, h / b.height);
      const z = Math.max(fit, MIN_READABLE_ZOOM);
      // Fits: centred in the free area; too big: readable zoom from the top left (Бриф → CEO).
      const x = fit >= MIN_READABLE_ZOOM ? pad + (w - b.width * z) / 2 : pad;
      const y = fit >= MIN_READABLE_ZOOM ? pad + (h - b.height * z) / 2 : pad;
      void rf.setViewport({ x: x - b.x * z, y: y - b.y * z, zoom: z }, { duration });
    },
    [rf],
  );
  const fitted = useRef(false);
  // «+ Агент» opens the library next to the board (cards can be dropped onto it).
  const [library, setLibrary] = useState<AddTab | null>(null);
  const basicTeam = useAction(
    () => api.post('/api/library/team'),
    () => setTimeout(() => fitBoard(), 300),
  );
  const addTemplate = useAction(
    (v: { templateId: string; position: { x: number; y: number } }) =>
      api.post('/api/library/add', v),
    (r) => r.ok && r.id && setSel({ type: 'node', id: r.id }),
  );
  // The minimap covers part of the board: shown only on request.
  const [showMap, setShowMap] = useState(false);

  const addLink = useAction((v: { from: string; to: string }) =>
    api.post('/api/workspace/links', v),
  );
  const delLink = useAction((id: string) => api.post(`/api/workspace/links/${id}/delete`));
  const autoLayout = useAction(
    () => api.post('/api/workspace/auto-layout'),
    () => setTimeout(() => fitBoard(), 300),
  );
  const saveLayout = useMutation({
    mutationFn: (positions: Record<string, { x: number; y: number }>) =>
      api.post('/api/workspace/layout', { positions }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['workspace'] }),
  });

  // A "started" event counts until the board data refreshed after it says otherwise.
  const liveAgents = useMemo(
    () =>
      new Set(
        Object.entries(started)
          .filter(
            ([a, at]) =>
              at > dataUpdatedAt - 1000 ||
              data?.nodes.find((n) => n.id === a)?.card?.status === 'working',
          )
          .map(([a]) => a),
      ),
    [started, dataUpdatedAt, data],
  );

  const pathNodes = useMemo(() => new Map(path?.nodes.map((n) => [n.agent, n]) ?? []), [path]);
  const pathLinks = useMemo(() => {
    if (!path?.pipeline) return null;
    const p = path.pipeline;
    const planner = p.planner ?? p.links.find((l) => l.from === BRIEF)?.to;
    const used = new Set([
      BRIEF,
      OWNER,
      ...(planner ? [planner] : []),
      ...path.nodes.map((n) => n.agent),
    ]);
    return { used, links: new Set(path.pipeline.links.map((l) => `${l.from}>${l.to}`)) };
  }, [path]);

  const frames = useMemo(() => replayFrames(runEvents ?? [], data?.links ?? []), [runEvents, data]);
  /** What the board shows instead of the live state: a replay frame or the demo. */
  const shown: DemoFrame | null = (replay && frames[replay.i]) || demo;
  // Decision labels: of the frame shown, else of the selected task as it is now.
  const labels = shown ? shown.labels : taskId ? frames.at(-1)?.labels : undefined;

  useEffect(() => {
    if (!replay?.playing) return;
    const t = setTimeout(
      () =>
        setReplay((r) =>
          !r ? r : r.i + 1 >= frames.length ? { ...r, playing: false } : { ...r, i: r.i + 1 },
        ),
      1600 / replay.speed,
    );
    return () => clearTimeout(t);
  }, [replay, frames.length]);

  const working = useCallback(
    (id: string) => {
      const n = data?.nodes.find((x) => x.id === id);
      if (!n) return false;
      return (
        nodeState(n, {
          demo: shown?.states[id] ?? null,
          live: liveAgents.has(id),
          path: replay ? null : (pathNodes.get(id) ?? null),
          taskSelected: !!taskId && !demo,
        }) === 'working'
      );
    },
    [data, shown, demo, replay, liveAgents, pathNodes, taskId],
  );

  const why = useCallback(
    (from: string, to: string) =>
      data ? validateLink(graphNodes(data), data.links, from, to) : 'Доска ещё не загрузилась',
    [data],
  );

  // Build nodes from server data; keep positions of nodes being dragged.
  useEffect(() => {
    if (!data) return;
    const built: BoardNode[] = data.nodes.map((n) => {
      const st = nodeState(n, {
        demo: shown?.states[n.id] ?? null,
        live: liveAgents.has(n.id),
        path: replay ? null : (pathNodes.get(n.id) ?? null),
        taskSelected: !!taskId && !demo,
      });
      const p = pathNodes.get(n.id);
      const doing = shown?.doing[n.id]
        ? shown.doing[n.id]!
        : taskId && path
          ? p
            ? `${path.title.slice(0, 60)}`
            : 'не участвует в задаче'
          : st === 'working' || st === 'waiting'
            ? (n.card?.currentTask?.title ?? n.role)
            : 'нет задачи';
      return {
        id: n.id,
        type: n.kind === 'human' ? 'human' : 'agent',
        position: n.position,
        // Delete on a card asks first (onBeforeDelete); «Бриф» and «Вы» are not agents.
        deletable: n.kind !== 'human',
        selected: sel?.type === 'node' && sel.id === n.id,
        data: {
          node: n,
          state: st,
          doing,
          dim: !!pathLinks && !demo && !pathLinks.used.has(n.id),
          verdict: taskId && !demo ? (p?.verdict ?? null) : null,
          stepCost: taskId && !demo ? (p?.costUsd ?? null) : null,
          waitingOwner: approvals?.count ?? 0,
          linking: !linkFrom
            ? null
            : linkFrom === n.id
              ? 'source'
              : why(linkFrom, n.id) === null
                ? 'ok'
                : 'bad',
          onLinkStart: setLinkFrom,
        },
      };
    });
    setNodes((prev) =>
      built.map((b) => {
        const old = prev.find((x) => x.id === b.id);
        return old?.dragging ? { ...b, position: old.position, dragging: true } : b;
      }),
    );
    // «Вписать» once when the page opens (after the first render of the cards).
    if (!fitted.current && built.length) {
      fitted.current = true;
      setTimeout(() => fitBoard(0), 50);
    }
  }, [
    data,
    demo,
    shown,
    replay,
    liveAgents,
    pathNodes,
    pathLinks,
    taskId,
    path,
    sel,
    approvals,
    setNodes,
    linkFrom,
    why,
    fitBoard,
  ]);

  // Esc cancels linking by clicks.
  useEffect(() => {
    if (!linkFrom) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLinkFrom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkFrom]);
  /** Creates a link after a check in the browser (same rules as the server); refusals say why. */
  const tryLink = useCallback(
    (from: string, to: string) => {
      const reason = data ? validateLink(graphNodes(data), data.links, from, to) : 'Подождите';
      if (reason) toast(reason, false);
      else addLink.mutate({ from, to });
    },
    [data, toast, addLink],
  );

  const edges: BoardEdge[] = useMemo(() => {
    if (!data) return [];
    return data.links.map((l) => {
      const from = data.nodes.find((n) => n.id === l.from);
      const color = from && from.kind !== 'human' ? agentVar(from.color) : 'var(--primary)';
      const key = `${l.from}>${l.to}`;
      const onPath = pathLinks ? pathLinks.links.has(key) : true;
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        type: 'flow',
        selected: sel?.type === 'edge' && sel.id === l.id,
        deletable: l.deletable,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: 'var(--border-strong)',
        },
        ariaLabel: `Связь ${from?.name ?? l.from} → ${data.nodes.find((n) => n.id === l.to)?.name ?? l.to}`,
        data: {
          color,
          flowing: !!shown?.flows?.includes(key) || working(l.from),
          decision: labels?.[key] ?? null,
          active: l.active,
          dim: !!pathLinks && !demo && !onPath,
          deletable: l.deletable,
          onDelete: () => setConfirmLink(l),
        },
      };
    });
  }, [data, sel, pathLinks, demo, shown, labels, working]);

  const onNodesChangeSel = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      onNodesChange(changes);
      for (const c of changes)
        if (c.type === 'select' && c.selected) setSel({ type: 'node', id: c.id });
    },
    [onNodesChange],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<BoardEdge>[]) => {
    for (const c of changes)
      if (c.type === 'select' && c.selected) setSel({ type: 'edge', id: c.id });
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | BoardEdge) => why(c.source, c.target) === null,
    [why],
  );
  const onConnect = useCallback(
    (c: Connection) => addLink.mutate({ from: c.source, to: c.target }),
    [addLink],
  );
  // Dropping on any part of a card works (not only on its input point): valid -> link, else reason.
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      state: {
        isValid: boolean | null;
        fromNode: { id: string } | null;
        toNode: { id: string } | null;
      },
    ) => {
      if (state.isValid || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const el = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
      const target = state.toNode?.id ?? el?.closest('.react-flow__node')?.getAttribute('data-id');
      if (!target || target === state.fromNode.id) return;
      const reason = why(state.fromNode.id, target);
      if (reason) toast(reason, false);
      else addLink.mutate({ from: state.fromNode.id, to: target });
    },
    [why, toast, addLink],
  );

  const stopDemo = useCallback(() => {
    if (demoTimer.current) clearInterval(demoTimer.current);
    demoTimer.current = null;
    setDemo(null);
  }, []);
  const startDemo = useCallback(() => {
    if (!data) return;
    setTaskId(null);
    setReplay(null);
    const frames = demoScript(buildPipeline(graphNodes(data), data.links), data);
    let i = 0;
    setDemoFeed([]);
    const tick = () => {
      const f = frames[i];
      if (!f) {
        stopDemo();
        return;
      }
      setDemo(f);
      setDemoFeed((feed) =>
        [
          {
            id: -(i + 1),
            at: new Date().toISOString(),
            agent: f.eventAgent,
            taskId: null,
            runId: null,
            kind: 'info',
            text: f.event,
            costUsd: 0,
          },
          ...feed,
        ].slice(0, 50),
      );
      i++;
    };
    tick();
    demoTimer.current = setInterval(tick, 2200);
  }, [data, stopDemo]);
  useEffect(() => stopDemo, [stopDemo]);

  // Keep the whole board visible when the window size changes (phone rotation, resize).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fitBoard(150), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [fitBoard]);

  // Delete / Backspace: nothing goes without a question; the dialog does the deleting.
  const onBeforeDelete = useCallback(
    async ({ nodes: delNodes, edges: del }: { nodes: BoardNode[]; edges: BoardEdge[] }) => {
      const n = delNodes.find((x) => x.type === 'agent');
      const link = del[0] && data?.links.find((l) => l.id === del[0]!.id);
      if (n) setConfirmAgent(n.id);
      else if (link) setConfirmLink(link);
      else if (delNodes.length) toast(HUMAN_NODE_HINT, false);
      return Promise.resolve(false);
    },
    [data, toast],
  );

  if (isLoading) return <Loading rows={2} />;
  if (!data) return <ErrorBox error={error} />;

  const taskRun = taskId && !demo ? (runEvents ?? []) : null;
  const feed = demo || demoFeed.length ? demoFeed : (events ?? []);
  const nodeColor = (agent: string) => {
    const n = data.nodes.find((x) => x.id === agent);
    return n && n.kind !== 'human' ? agentVar(n.color) : 'var(--text-3)';
  };
  const openTasks = (tasks ?? [])
    .filter((t) => !['cancelled', 'failed'].includes(t.status))
    .slice(0, 30);

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 'var(--s-3)', gap: 'var(--s-3)' }}>
        <label className="row small" htmlFor="task-picker">
          Задача
        </label>
        <select
          id="task-picker"
          className="task-picker"
          title={openTasks.find((t) => t.id === taskId)?.title ?? 'Все задачи'}
          value={taskId ?? ''}
          onChange={(e) => {
            stopDemo();
            setReplay(null);
            setTaskId(e.target.value || null);
          }}
        >
          <option value="">Все задачи</option>
          {openTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title.slice(0, 60)} · {STATUS_LABEL[t.status]}
            </option>
          ))}
        </select>
        {status?.provider === 'mock' && (
          <Button onClick={demo ? stopDemo : startDemo}>
            <Icon name={demo ? 'stop' : 'play'} /> {demo ? 'Остановить показ' : 'Показать пример'}
          </Button>
        )}
        {taskId && frames.length > 0 && (
          <div className="row replay" role="group" aria-label="Повтор хода задачи">
            <Button
              className="btn-sm"
              onClick={() =>
                setReplay((r) =>
                  r?.playing
                    ? { ...r, playing: false }
                    : {
                        i: r && r.i + 1 < frames.length ? r.i : 0,
                        playing: true,
                        speed: r?.speed ?? 1,
                      },
                )
              }
            >
              <Icon name={replay?.playing ? 'stop' : 'play'} />{' '}
              {replay?.playing ? 'Пауза' : 'Повтор'}
            </Button>
            <select
              aria-label="Скорость повтора"
              className="replay-speed"
              value={replay?.speed ?? 1}
              onChange={(e) =>
                setReplay((r) => ({
                  i: r?.i ?? 0,
                  playing: r?.playing ?? false,
                  speed: Number(e.target.value) === 4 ? 4 : 1,
                }))
              }
            >
              <option value={1}>1×</option>
              <option value={4}>4×</option>
            </select>
            <input
              type="range"
              aria-label="Момент хода задачи"
              min={0}
              max={frames.length - 1}
              value={replay?.i ?? frames.length - 1}
              onChange={(e) =>
                setReplay((r) => ({
                  i: Number(e.target.value),
                  playing: false,
                  speed: r?.speed ?? 1,
                }))
              }
            />
            <span className="small muted tabular">
              {(replay?.i ?? frames.length - 1) + 1}/{frames.length}
            </span>
            {replay && (
              <Button className="btn-sm" variant="ghost" onClick={() => setReplay(null)}>
                Сейчас
              </Button>
            )}
          </div>
        )}
        <span className="muted small" title="Как обновляется доска">
          {mode === 'live'
            ? '● в реальном времени'
            : mode === 'polling'
              ? '○ обновление раз в 3 с'
              : '…'}
        </span>
      </div>
      <div className="ws-layout">
        <div>
          <div className="ws-toolbar">
            <Button className="btn-sm" onClick={() => void fitBoard()}>
              <Icon name="fit" /> Вписать
            </Button>
            <Button
              className="btn-sm"
              aria-label="Уменьшить"
              title="Уменьшить"
              onClick={() => void rf.zoomOut({ duration: 150 })}
            >
              −
            </Button>
            <Button
              className="btn-sm"
              aria-label="Увеличить"
              title="Увеличить"
              onClick={() => void rf.zoomIn({ duration: 150 })}
            >
              +
            </Button>
            <Button className="btn-sm" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)}>
              {showMap ? 'Скрыть карту' : 'Карта'}
            </Button>
            <Button
              className="btn-sm"
              busy={autoLayout.isPending}
              onClick={() => autoLayout.mutate(undefined)}
            >
              <Icon name="layout" /> Авторасстановка
            </Button>
            <Button
              className="btn-sm"
              aria-expanded={!!library}
              onClick={() => setLibrary((v) => (v ? null : 'library'))}
            >
              <Icon name="plus" /> Агент
            </Button>
          </div>
          {!data.nodes.some((n) => n.kind !== 'human') && (
            <div className="ws-empty card stack" role="region" aria-label="Соберите команду">
              <h2>Соберите команду</h2>
              <p className="small muted">
                На доске пока нет агентов — задачи будут ждать в «приёме». Нужен хотя бы
                планировщик: он получает бриф и строит план.
              </p>
              <Button
                variant="primary"
                busy={basicTeam.isPending}
                onClick={() => basicTeam.mutate(undefined)}
              >
                Базовая команда
              </Button>
              <span className="faint small">
                Планировщик, Копирайтер и Проверяющий из библиотеки, связаны, проверены на mock и
                включены.
              </span>
              <div className="row wrap">
                <Button onClick={() => setLibrary('library')}>Выбрать из библиотеки</Button>
                <Button onClick={() => setLibrary('empty')}>Создать с нуля</Button>
              </div>
            </div>
          )}
          <div
            className="ws-board"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TEMPLATE_DND)) e.preventDefault();
            }}
            onDrop={(e) => {
              const templateId = e.dataTransfer.getData(TEMPLATE_DND);
              if (!templateId) return;
              e.preventDefault();
              const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
              addTemplate.mutate({
                templateId,
                position: { x: Math.round(p.x), y: Math.round(p.y) },
              });
            }}
          >
            <ReactFlow<BoardNode, BoardEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChangeSel}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              onBeforeDelete={onBeforeDelete}
              onEdgeClick={(_, e) => setSel({ type: 'edge', id: e.id })}
              onNodeClick={(_, n) => {
                if (linkFrom) {
                  if (n.id !== linkFrom) tryLink(linkFrom, n.id);
                  setLinkFrom(null);
                  return;
                }
                setSel({ type: 'node', id: n.id });
              }}
              onPaneClick={() => {
                setLinkFrom(null);
                setSel(null);
              }}
              onNodeDragStop={(_, _n, dragged) =>
                saveLayout.mutate(
                  Object.fromEntries(
                    dragged.map((d) => [
                      d.id,
                      { x: Math.round(d.position.x), y: Math.round(d.position.y) },
                    ]),
                  ),
                )
              }
              deleteKeyCode={['Delete', 'Backspace']}
              minZoom={0.3}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
              ariaLabelConfig={{
                'node.a11yDescription.default':
                  'Нажмите Enter, чтобы выбрать агента. Стрелки двигают узел.',
                'edge.a11yDescription.default':
                  'Нажмите Enter, чтобы выбрать связь, Delete — удалить.',
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
              {showMap && (
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  nodeStrokeWidth={2}
                  style={{ width: 140, height: 90 }}
                />
              )}
            </ReactFlow>
            {linkFrom && (
              <div className="ws-linking" role="status">
                <span>
                  Связь от «{data.nodes.find((n) => n.id === linkFrom)?.name}»: нажмите на агента,
                  которому передавать результат
                </span>
                <button type="button" onClick={() => setLinkFrom(null)}>
                  Отмена (Esc)
                </button>
              </div>
            )}
          </div>
          <div className="ws-hint">
            Связь: потяните точку справа у агента к другому или нажмите на точку, затем на
            получателя. Клик по линии — удалить.
          </div>
          <section className="card feed" aria-live="polite">
            <div className="row between" style={{ marginBottom: 'var(--s-2)' }}>
              <h2>{taskRun ? 'Ход задачи' : 'Что происходит сейчас'}</h2>
              <span className="muted small">{(taskRun ?? feed).length} событий</span>
            </div>
            {taskRun ? (
              <ol className="feed-list run-feed">
                {[...taskRun].reverse().map((e, k) => {
                  const idx = taskRun.length - 1 - k;
                  return (
                    <li
                      key={e.id}
                      className={`feed-row run-${e.type}${replay && idx > replay.i ? ' future' : ''}${replay?.i === idx ? ' current' : ''}`}
                      style={{ '--agent': nodeColor(e.agent) } as CSSProperties}
                    >
                      <time>{timeOf(e.at)}</time>
                      <i aria-hidden />
                      <span>{e.text}</span>
                      <span className="cost">
                        {e.costUsd != null && e.costUsd > 0 ? usd(e.costUsd) : ''}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : feed.length === 0 ? (
              <Empty icon="activity">
                Событий пока нет. Отправьте бриф или нажмите «Показать пример».
              </Empty>
            ) : (
              <div className="feed-list">
                {feed.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="feed-row"
                    style={{ '--agent': nodeColor(e.agent) } as CSSProperties}
                    onClick={() =>
                      e.runId
                        ? navigate(`/runs/${e.runId}`)
                        : e.taskId
                          ? navigate(`/tasks/${e.taskId}`)
                          : undefined
                    }
                  >
                    <time>{timeOf(e.at)}</time>
                    <i aria-hidden />
                    <span>{e.text}</span>
                    <span className="cost">
                      {e.costUsd != null && e.costUsd > 0 ? usd(e.costUsd) : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
        <SidePanel
          ws={data}
          sel={sel}
          onDrawer={(id, tab) => setDrawer({ id, tab })}
          onDeleteLink={setConfirmLink}
          onAddLink={tryLink}
          onToggleLink={(from, to, on) => {
            const existing = data.links.find((l) => l.from === from && l.to === to);
            if (on && !existing) addLink.mutate({ from, to });
            if (!on && existing) delLink.mutate(existing.id);
          }}
          onDeleteAgent={setConfirmAgent}
          approvals={approvals?.count ?? 0}
        />
      </div>
      {library && (
        <Library
          key={library}
          tab={library}
          onClose={() => setLibrary(null)}
          onAdded={(id) => setSel({ type: 'node', id })}
        />
      )}
      {confirmLink && (
        <Modal title="Удалить связь?" onClose={() => setConfirmLink(null)}>
          <div className="modal-text">
            {data.nodes.find((n) => n.id === confirmLink.from)?.name} →{' '}
            {data.nodes.find((n) => n.id === confirmLink.to)?.name}. Новые задачи пойдут без этого
            шага; задачи с уже утверждённым планом доработают как было.
          </div>
          <div className="row end">
            <Button onClick={() => setConfirmLink(null)}>Нет</Button>
            <Button
              variant="danger"
              onClick={() => {
                delLink.mutate(confirmLink.id);
                setConfirmLink(null);
                setSel(null);
              }}
            >
              Да, удалить
            </Button>
          </div>
        </Modal>
      )}
      {confirmAgent && data.nodes.some((x) => x.id === confirmAgent) && (
        <DeleteAgentDialog
          agent={data.nodes.find((x) => x.id === confirmAgent)!}
          lastPlanner={
            data.nodes.find((x) => x.id === confirmAgent)?.teamRole === 'planner' &&
            data.nodes.filter((x) => x.kind !== 'human' && x.teamRole === 'planner').length === 1
          }
          onClose={() => setConfirmAgent(null)}
          onDeleted={() => {
            setConfirmAgent(null);
            setSel(null);
          }}
        />
      )}
      {drawer && (
        <AgentDrawer
          agentId={drawer.id}
          tab={drawer.tab}
          onTab={(tab) => setDrawer({ ...drawer, tab })}
          onClose={() => setDrawer(null)}
        />
      )}
    </>
  );
}

function SidePanel({
  ws,
  sel,
  onDrawer,
  onDeleteLink,
  onAddLink,
  onToggleLink,
  onDeleteAgent,
  approvals,
}: {
  ws: WorkspaceData;
  sel: Selection;
  onDrawer: (id: string, tab: DrawerTab) => void;
  onDeleteLink: (l: WorkspaceLinkData) => void;
  onAddLink: (from: string, to: string) => void;
  onToggleLink: (from: string, to: string, on: boolean) => void;
  onDeleteAgent: (id: string) => void;
  approvals: number;
}) {
  const nameOf = (id: string) => ws.nodes.find((n) => n.id === id)?.name ?? id;
  if (!sel) {
    return (
      <aside className="side-panel">
        <Empty icon="agents">Выберите агента или связь на доске.</Empty>
      </aside>
    );
  }
  if (sel.type === 'edge') {
    const l = ws.links.find((x) => x.id === sel.id);
    if (!l) return <aside className="side-panel" />;
    return (
      <aside className="side-panel stack">
        <h2>Связь</h2>
        <p>
          <b>{nameOf(l.from)}</b> → <b>{nameOf(l.to)}</b>
        </p>
        <p className="muted small">
          Результат «{nameOf(l.from)}» передаётся на вход «{nameOf(l.to)}», и «{nameOf(l.to)}»
          запускается после него. Изменения действуют для новых задач.
        </p>
        {!l.active && (
          <div className="warn small">Пока не работает: один из агентов ещё не активен.</div>
        )}
        <Button variant="danger" onClick={() => onDeleteLink(l)}>
          <Icon name="trash" /> Удалить связь
        </Button>
      </aside>
    );
  }
  const n = ws.nodes.find((x) => x.id === sel.id);
  if (!n) return <aside className="side-panel" />;
  const from = ws.links.filter((l) => l.to === n.id).map((l) => nameOf(l.from));
  const to = ws.links.filter((l) => l.from === n.id).map((l) => nameOf(l.to));
  if (n.kind === 'human') {
    return (
      <aside className="side-panel stack">
        <h2>{n.name}</h2>
        <p className="muted">{n.description}</p>
        <p className="faint small">{HUMAN_NODE_HINT}</p>
        {n.id === BRIEF ? (
          <Link to="/tasks/new" className="btn btn-primary">
            <Icon name="plus" /> Новая задача
          </Link>
        ) : (
          <Link to="/approvals" className="btn btn-primary">
            Согласование{approvals ? ` · ${approvals}` : ''}
          </Link>
        )}
      </aside>
    );
  }
  const card = n.card;
  // «Приёмка»: agents with the acceptor role get everything that is ready (SEO and the like).
  const acceptors = ws.nodes.filter(
    (x) => x.kind !== 'human' && x.teamRole === 'acceptor' && x.id !== n.id,
  );
  return (
    <aside className="side-panel stack" style={{ '--agent': agentVar(n.color) } as CSSProperties}>
      <div className="row">
        <div className="avatar" aria-hidden>
          {n.icon}
        </div>
        <div className="title-block">
          <h2>{n.name}</h2>
          <small>{n.role}</small>
        </div>
      </div>
      <div className="row wrap">
        {n.teamRole && <Pill tone="accent">{TEAM_ROLE_LABEL[n.teamRole]}</Pill>}
        {n.capabilityName && <Pill tone="info">{n.capabilityName}</Pill>}
      </div>
      <div>
        <StatePill
          state={nodeState(n, { demo: null, live: false, path: null, taskSelected: false })}
        />
      </div>
      <p className="muted small">{n.description}</p>
      <dl className="facts">
        <dt>Получает от</dt>
        <dd>{from.join(', ') || '—'}</dd>
        <dt>Передаёт</dt>
        <dd>{to.join(', ') || '—'}</dd>
        {card && (
          <>
            <dt>Сейчас</dt>
            <dd className="clamp-2" title={card.currentTask?.title ?? ''}>
              {card.currentTask ? (
                <Link to={`/tasks/${card.currentTask.id}`}>{card.currentTask.title}</Link>
              ) : (
                'нет задачи'
              )}
            </dd>
            <dt>Модель</dt>
            <dd>
              <code>{card.model.name}</code>{' '}
              <span className="muted small">
                {card.model.source === 'panel' ? 'из панели' : 'из .env'}
              </span>
            </dd>
            <dt>Промпт</dt>
            <dd>
              <code>{card.promptVersion ?? 'не сохранён'}</code>
            </dd>
            <dt>Запусков (30 дн.)</dt>
            <dd>{card.runs30}</dd>
            <dt>Расход сегодня</dt>
            <dd>{usd(card.spentTodayUsd)}</dd>
          </>
        )}
        {n.status !== 'active' && (
          <>
            <dt>Статус</dt>
            <dd>черновик — работать начнёт после теста и включения</dd>
          </>
        )}
      </dl>
      <LinkEditor ws={ws} from={n.id} onAdd={onAddLink} onDelete={onDeleteLink} />
      {n.tool && (
        <details className="tool-params" open>
          <summary>Параметры</summary>
          <dl className="facts small">
            {Object.entries(n.tool.params).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
            <dt>Читает</dt>
            <dd>{n.tool.permissions.reads.join(', ') || '—'}</dd>
            <dt>Пишет</dt>
            <dd>{n.tool.permissions.writes.join(', ') || '—'}</dd>
            <dt>Внешние адреса</dt>
            <dd>{n.tool.permissions.hosts.join(', ') || 'нет — всё на этом компьютере'}</dd>
          </dl>
          <div className="faint small">
            Меняются в .env и после перезапуска; из панели — только чтение.
          </div>
          {n.capability === 'mailer_send' && <Link to="/mailing">Открыть «Рассылку»</Link>}
          {(n.capability === 'stt_voice' || n.capability === 'video_transcribe') && (
            <Link to="/transcripts">Открыть «Расшифровки»</Link>
          )}
        </details>
      )}
      <div className="row wrap">
        {card && n.status === 'active' && (
          <PauseButton agentId={n.id} paused={card.controls.paused} name={n.name} />
        )}
        <Button variant="primary" onClick={() => navigate(`/agents/${n.id}/build`)}>
          <Icon name="settings" /> {n.status === 'active' ? 'Конструктор' : 'Собрать агента'}
        </Button>
        <Button onClick={() => navigate(`/agents/${n.id}/blocks`)}>
          <Icon name="layout" /> Блоки
        </Button>
        {n.status === 'active' && (
          <>
            <Button onClick={() => onDrawer(n.id, 'test')}>
              <Icon name="test" /> Тест
            </Button>
            <Button onClick={() => onDrawer(n.id, 'overview')}>Настроить</Button>
          </>
        )}
      </div>
      <SaveToLibrary agentId={n.id} />
      {acceptors.map((acc) => {
        const accLink = ws.links.find((l) => l.from === n.id && l.to === acc.id);
        return (
          <label key={acc.id} className="switch">
            <input
              type="checkbox"
              checked={!!accLink}
              onChange={(e) => onToggleLink(n.id, acc.id, e.target.checked)}
            />
            Результат проходит приёмку «{acc.name}»
          </label>
        );
      })}
      <Button variant="danger" onClick={() => onDeleteAgent(n.id)}>
        <Icon name="trash" /> Удалить агента
      </Button>
    </aside>
  );
}

/** «Передавать результат →»: the receivers this agent may get, without dragging thin points. */
function LinkEditor({
  ws,
  from,
  onAdd,
  onDelete,
}: {
  ws: WorkspaceData;
  from: string;
  onAdd: (from: string, to: string) => void;
  onDelete: (l: WorkspaceLinkData) => void;
}) {
  const nodes = graphNodes(ws);
  const options = ws.nodes.filter(
    (x) => x.id !== from && validateLink(nodes, ws.links, from, x.id) === null,
  );
  const [to, setTo] = useState('');
  const out = ws.links.filter((l) => l.from === from);
  const nameOf = (id: string) => ws.nodes.find((x) => x.id === id)?.name ?? id;
  const value = options.some((o) => o.id === to) ? to : '';
  return (
    <div className="stack link-editor">
      <b className="small">Передаёт результат</b>
      {out.length === 0 && <div className="muted small">пока никому</div>}
      {out.map((l) => (
        <div key={l.id} className="row between small">
          <span>
            → {nameOf(l.to)}
            {!l.active && <span className="warn"> · не работает, пока агент не активен</span>}
          </span>
          <button
            type="button"
            className="linklike danger"
            aria-label={`Удалить связь с ${nameOf(l.to)}`}
            onClick={() => onDelete(l)}
          >
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <label className="small" htmlFor={`link-to-${from}`}>
        Передавать результат →
      </label>
      <div className="row">
        <select
          id={`link-to-${from}`}
          value={value}
          onChange={(e) => setTo(e.target.value)}
          disabled={options.length === 0}
        >
          <option value="">{options.length ? 'выберите агента' : 'некому: все связи есть'}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.status !== 'active' && o.kind !== 'human' ? ' (не активен)' : ''}
            </option>
          ))}
        </select>
        <Button
          className="btn-sm"
          disabled={!value}
          onClick={() => {
            onAdd(from, value);
            setTo('');
          }}
        >
          <Icon name="link" /> Связать
        </Button>
      </div>
    </div>
  );
}

export const HUMAN_NODE_HINT =
  '«Бриф» и «Вы» — не агенты: это вход задачи и ваше согласование. Их нельзя удалить.';

/** «В библиотеку»: the constructor agent becomes the owner's template (a new version each time). */
function SaveToLibrary({ agentId }: { agentId: string }) {
  const { data } = useLibrary();
  const [cat, setCat] = useState('Контент');
  const save = useAction(() => api.post('/api/library/save', { agentId, category: cat }));
  return (
    <div className="row">
      <select
        aria-label="Категория в библиотеке"
        className="replay-speed"
        value={cat}
        onChange={(e) => setCat(e.target.value)}
      >
        {(data?.categories ?? ['Контент']).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <Button busy={save.isPending} onClick={() => save.mutate(undefined)}>
        В библиотеку
      </Button>
    </div>
  );
}
