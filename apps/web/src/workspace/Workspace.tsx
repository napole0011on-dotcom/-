import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { buildPipeline, validateLink, type GraphNode } from '@cms/agents/graph';
import { api, type LiveEvent, type WorkspaceData, type WorkspaceLinkData } from '../api';
import { STATUS_LABEL, usd } from '../format';
import { Icon } from '../icons';
import { useLiveEvents } from '../live';
import {
  useApprovals,
  useEvents,
  useStatus,
  useTaskPath,
  useTasks,
  useWorkspace,
} from '../queries';
import { navigate } from '../router';
import { Button, Empty, ErrorBox, Link, Loading, Modal, useAction, useToast } from '../ui';
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

type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

function graphNodes(ws: WorkspaceData): GraphNode[] {
  return ws.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, status: n.status }));
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
  const [sel, setSel] = useState<Selection>({ type: 'node', id: 'ceo' });
  const [taskId, setTaskId] = useState<string | null>(null);
  const { data: path } = useTaskPath(taskId);
  const [demo, setDemo] = useState<DemoFrame | null>(null);
  const [demoFeed, setDemoFeed] = useState<LiveEvent[]>([]);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [confirmLink, setConfirmLink] = useState<WorkspaceLinkData | null>(null);
  const [drawer, setDrawer] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardNode>([]);

  const addLink = useAction((v: { from: string; to: string }) =>
    api.post('/api/workspace/links', v),
  );
  const delLink = useAction((id: string) => api.post(`/api/workspace/links/${id}/delete`));
  const autoLayout = useAction(
    () => api.post('/api/workspace/auto-layout'),
    () => setTimeout(() => void rf.fitView({ padding: 0.2, duration: 200 }), 300),
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
    const used = new Set(['brief', 'ceo', 'me', ...path.nodes.map((n) => n.agent)]);
    return { used, links: new Set(path.pipeline.links.map((l) => `${l.from}>${l.to}`)) };
  }, [path]);

  const working = useCallback(
    (id: string) => {
      const n = data?.nodes.find((x) => x.id === id);
      if (!n) return false;
      return (
        nodeState(n, {
          demo: demo?.states[id] ?? null,
          live: liveAgents.has(id),
          path: pathNodes.get(id) ?? null,
          taskSelected: !!taskId && !demo,
        }) === 'working'
      );
    },
    [data, demo, liveAgents, pathNodes, taskId],
  );

  // Build nodes from server data; keep positions of nodes being dragged.
  useEffect(() => {
    if (!data) return;
    const built: BoardNode[] = data.nodes.map((n) => {
      const st = nodeState(n, {
        demo: demo?.states[n.id] ?? null,
        live: liveAgents.has(n.id),
        path: pathNodes.get(n.id) ?? null,
        taskSelected: !!taskId && !demo,
      });
      const p = pathNodes.get(n.id);
      const doing = demo?.doing[n.id]
        ? demo.doing[n.id]!
        : taskId && path
          ? p
            ? `${path.title.slice(0, 60)}`
            : 'не участвует в задаче'
          : st === 'working' || st === 'waiting'
            ? (n.card?.currentTask?.title ?? n.role)
            : n.status === 'planned'
              ? 'появится на следующих этапах'
              : 'нет задачи';
      return {
        id: n.id,
        type: n.kind === 'human' ? 'human' : 'agent',
        position: n.position,
        deletable: false,
        selected: sel?.type === 'node' && sel.id === n.id,
        data: {
          node: n,
          state: st,
          doing,
          dim: !!pathLinks && !demo && !pathLinks.used.has(n.id),
          verdict: taskId && !demo ? (p?.verdict ?? null) : null,
          stepCost: taskId && !demo ? (p?.costUsd ?? null) : null,
          waitingOwner: approvals?.count ?? 0,
        },
      };
    });
    setNodes((prev) =>
      built.map((b) => {
        const old = prev.find((x) => x.id === b.id);
        return old?.dragging ? { ...b, position: old.position, dragging: true } : b;
      }),
    );
  }, [data, demo, liveAgents, pathNodes, pathLinks, taskId, path, sel, approvals, setNodes]);

  const edges: BoardEdge[] = useMemo(() => {
    if (!data) return [];
    return data.links.map((l) => {
      const from = data.nodes.find((n) => n.id === l.from);
      const color = from && from.kind !== 'human' ? agentVar(from.color) : 'var(--primary)';
      const onPath = pathLinks ? pathLinks.links.has(`${l.from}>${l.to}`) : true;
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
          flowing: working(l.from),
          active: l.active,
          dim: !!pathLinks && !demo && !onPath,
          deletable: l.deletable,
          system: l.kind === 'system',
          onDelete: () => setConfirmLink(l),
        },
      };
    });
  }, [data, sel, pathLinks, demo, working]);

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

  const why = useCallback(
    (from: string, to: string) =>
      data ? validateLink(graphNodes(data), data.links, from, to) : 'Доска ещё не загрузилась',
    [data],
  );
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
      t = setTimeout(() => void rf.fitView({ padding: 0.2, duration: 150 }), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [rf]);

  const onBeforeDelete = useCallback(
    async ({ edges: del }: { nodes: BoardNode[]; edges: BoardEdge[] }) => {
      const e = del[0];
      const link = e && data?.links.find((l) => l.id === e.id);
      if (link?.deletable) setConfirmLink(link);
      else if (link) toast('Это связь основного конвейера, её удалить нельзя', false);
      return Promise.resolve(false);
    },
    [data, toast],
  );

  if (isLoading) return <Loading rows={2} />;
  if (!data) return <ErrorBox error={error} />;

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
          style={{ width: 'auto', maxWidth: 360 }}
          value={taskId ?? ''}
          onChange={(e) => {
            stopDemo();
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
          <div className="ws-board">
            <div className="ws-toolbar">
              <Button
                className="btn-sm"
                onClick={() => void rf.fitView({ padding: 0.2, duration: 200 })}
              >
                <Icon name="fit" /> Вписать
              </Button>
              <Button
                className="btn-sm"
                busy={autoLayout.isPending}
                onClick={() => autoLayout.mutate(undefined)}
              >
                <Icon name="layout" /> Авторасстановка
              </Button>
              <Button className="btn-sm" onClick={() => navigate('/agents/new')}>
                <Icon name="plus" /> Агент
              </Button>
            </div>
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
              onNodeClick={(_, n) => setSel({ type: 'node', id: n.id })}
              onPaneClick={() => setSel(null)}
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
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
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
              <Controls showInteractive={false} position="bottom-right" />
              {data.nodes.length >= 8 && (
                <MiniMap pannable zoomable position="top-right" nodeStrokeWidth={2} />
              )}
            </ReactFlow>
            <div className="ws-hint">
              Потяните точку справа у агента к другому — связь. Клик по линии — удалить.
            </div>
          </div>
          <section className="card feed" aria-live="polite">
            <div className="row between" style={{ marginBottom: 'var(--s-2)' }}>
              <h2>Что происходит сейчас</h2>
              <span className="muted small">{feed.length} событий</span>
            </div>
            {feed.length === 0 ? (
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
          onToggleSeo={(from, on) => {
            const existing = data.links.find((l) => l.from === from && l.to === 'seo');
            if (on && !existing) addLink.mutate({ from, to: 'seo' });
            if (!on && existing?.deletable) delLink.mutate(existing.id);
          }}
          approvals={approvals?.count ?? 0}
        />
      </div>
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

const CODE_AGENTS = new Set(['ceo', 'copywriter', 'critic']);

function SidePanel({
  ws,
  sel,
  onDrawer,
  onDeleteLink,
  onToggleSeo,
  approvals,
}: {
  ws: WorkspaceData;
  sel: Selection;
  onDrawer: (id: string, tab: DrawerTab) => void;
  onDeleteLink: (l: WorkspaceLinkData) => void;
  onToggleSeo: (from: string, on: boolean) => void;
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
        {l.deletable ? (
          <Button variant="danger" onClick={() => onDeleteLink(l)}>
            <Icon name="trash" /> Удалить связь
          </Button>
        ) : (
          <div className="muted small">Связь основного конвейера — удалить нельзя.</div>
        )}
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
        {n.id === 'brief' ? (
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
  const seo = ws.nodes.find((x) => x.id === 'seo');
  const seoLink = ws.links.find((l) => l.from === n.id && l.to === 'seo');
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
            <dd>
              {n.status === 'planned' ? 'запланирован — связи с ним заработают сами' : 'черновик'}
            </dd>
          </>
        )}
      </dl>
      {card && CODE_AGENTS.has(n.id) && (
        <div className="row wrap">
          <PauseButton agentId={n.id} paused={card.controls.paused} name={n.name} />
          <Button onClick={() => onDrawer(n.id, 'test')}>
            <Icon name="test" /> Тест
          </Button>
          <Button variant="primary" onClick={() => onDrawer(n.id, 'overview')}>
            <Icon name="settings" /> Настроить
          </Button>
        </div>
      )}
      {n.kind === 'constructor' && (
        <div className="row wrap">
          {card && n.status === 'active' && (
            <PauseButton agentId={n.id} paused={card.controls.paused} name={n.name} />
          )}
          <Button variant="primary" onClick={() => navigate(`/agents/${n.id}/build`)}>
            <Icon name="settings" /> {n.status === 'active' ? 'Конструктор' : 'Собрать агента'}
          </Button>
        </div>
      )}
      {seo && n.id !== 'seo' && (
        <label className="switch">
          <input
            type="checkbox"
            checked={!!seoLink}
            disabled={!!seoLink && !seoLink.deletable}
            onChange={(e) => onToggleSeo(n.id, e.target.checked)}
          />
          Результат проходит приёмку SEO-менеджера
        </label>
      )}
    </aside>
  );
}
