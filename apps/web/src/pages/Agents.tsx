import { Suspense, lazy, useCallback, useState, type CSSProperties } from 'react';
import { AGENT_STATUS, agentVar, ago, percent, usd } from '../format';
import { Icon } from '../icons';
import { useAgents, useWorkspace } from '../queries';
import { Button, ErrorBox, Link, Loading, Pill } from '../ui';
import { AgentDrawer, PauseButton, type DrawerTab } from '../components/AgentDrawer';

// The board (React Flow) is a separate chunk: other pages load without it.
const Workspace = lazy(() =>
  import('../workspace/Workspace').then((m) => ({ default: m.Workspace })),
);

type View = 'board' | 'list';
const VIEW_KEY = 'cms-agents-view';
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
};

/** "Рабочий стол": the agent board (default) or the list of agent cards. */
export function Agents() {
  const [view, setView] = useState<View>(readView);
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private mode
    }
  };
  return (
    <>
      <div className="page-head">
        <h1>Рабочий стол</h1>
        <div className="seg" role="group" aria-label="Вид">
          <button type="button" aria-pressed={view === 'board'} onClick={() => choose('board')}>
            <Icon name="board" /> Доска
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => choose('list')}>
            <Icon name="list" /> Список
          </button>
        </div>
      </div>
      {view === 'board' ? (
        <Suspense fallback={<Loading rows={2} />}>
          <Workspace />
        </Suspense>
      ) : (
        <AgentList />
      )}
    </>
  );
}

function AgentList() {
  const { data, error, isLoading } = useAgents();
  const { data: ws } = useWorkspace();
  const colorOf = (id: string) => ws?.nodes.find((n) => n.id === id)?.color ?? 'indigo';
  const iconOf = (id: string) => ws?.nodes.find((n) => n.id === id)?.icon ?? id[0]!.toUpperCase();
  const [drawer, setDrawer] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const close = useCallback(() => setDrawer(null), []);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <ErrorBox error={error} />
      <div className="grid">
        {data.map((a) => {
          const st = AGENT_STATUS[a.status];
          return (
            <div
              className={`card agent-card ${a.controls.disabled ? 'agent-off' : ''}`}
              key={a.id}
              style={{ '--agent': agentVar(colorOf(a.id)) } as CSSProperties}
            >
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div className="row">
                  <div className="avatar" aria-hidden>
                    {iconOf(a.id)}
                  </div>
                  <div className="title-block">
                    <h2 className="clamp-1">{a.name}</h2>
                    <small className="clamp-1">{a.role}</small>
                  </div>
                </div>
                <div className="stack end-items">
                  <Pill tone={st.tone}>{st.label}</Pill>
                  {a.status === 'working' && (a.controls.paused || a.controls.allPaused) && (
                    <Pill tone="muted">⏸ пауза после текущего запуска</Pill>
                  )}
                </div>
              </div>
              <p className="small muted clamp-2">{a.description}</p>
              {a.waitingRuns > 0 && (
                <div className="paused small">
                  ⏳ В очереди ждут: {a.waitingRuns}. Продолжатся автоматически после
                  {a.controls.allPaused
                    ? ' «Продолжить всё»'
                    : a.controls.disabled
                      ? ' включения'
                      : ' «Продолжить»'}
                  .
                </div>
              )}
              <dl className="facts">
                <dt>Сейчас</dt>
                <dd>
                  {a.currentTask ? (
                    <Link
                      to={`/tasks/${a.currentTask.id}`}
                      className="clamp-2"
                      title={a.currentTask.title ?? ''}
                    >
                      {a.currentTask.title ?? 'задача'}
                    </Link>
                  ) : (
                    <span className="muted">нет задачи</span>
                  )}
                </dd>
                <dt>Последний запуск</dt>
                <dd>
                  {a.lastRunId ? <Link to={`/runs/${a.lastRunId}`}>{ago(a.lastRunAt)}</Link> : '—'}
                </dd>
                <dt>Успешность (30 дн.)</dt>
                <dd>
                  {percent(a.success.rate)}{' '}
                  <span className="muted small">
                    ({a.success.ok} ок / {a.success.failed} ошибок)
                  </span>
                </dd>
                <dt>Расход сегодня</dt>
                <dd>{usd(a.spentTodayUsd)}</dd>
                <dt>Модель</dt>
                <dd>
                  <code>{a.model.name}</code>{' '}
                  <span className={a.model.source === 'panel' ? 'warn small' : 'muted small'}>
                    {a.model.source === 'panel' ? 'задана в панели' : 'из .env'}
                  </span>
                  {a.model.ignoredOverride && (
                    <div className="danger small">
                      модели {a.model.ignoredOverride} из панели нет в прайсе — используется .env
                    </div>
                  )}
                </dd>
                <dt>Промпт</dt>
                <dd>
                  <code>{a.promptVersion ?? '—'}</code>
                  {a.pendingFilePrompt && (
                    <div>
                      <button
                        type="button"
                        className="linklike warn small"
                        onClick={() => setDrawer({ id: a.id, tab: 'prompt' })}
                      >
                        есть новая версия из файла ({a.pendingFilePrompt})
                      </button>
                    </div>
                  )}
                </dd>
              </dl>
              <div className="row wrap">
                {a.registryStatus === 'active' && (
                  <PauseButton agentId={a.id} paused={a.controls.paused} name={a.name} />
                )}
                {a.kind === 'constructor' ? (
                  <Link to={`/agents/${a.id}/build`} className="btn btn-primary">
                    {a.registryStatus === 'active' ? 'Конструктор' : 'Собрать агента'}
                  </Link>
                ) : a.registryStatus === 'active' ? (
                  <>
                    <Button onClick={() => setDrawer({ id: a.id, tab: 'test' })}>Тест</Button>
                    <Button onClick={() => setDrawer({ id: a.id, tab: 'overview' })}>
                      Настроить
                    </Button>
                  </>
                ) : (
                  <span className="muted small">запланирован — появится на следующем этапе</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {drawer && (
        <AgentDrawer
          agentId={drawer.id}
          tab={drawer.tab}
          onTab={(tab) => setDrawer({ ...drawer, tab })}
          onClose={close}
        />
      )}
    </>
  );
}
