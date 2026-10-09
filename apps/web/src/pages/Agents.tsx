import { useCallback, useState } from 'react';
import { AGENT_STATUS, ago, percent, usd } from '../format';
import { useAgents } from '../queries';
import { Button, ErrorBox, Link, Loading, Pill } from '../ui';
import { AgentDrawer, PauseButton, type DrawerTab } from '../components/AgentDrawer';

export function Agents() {
  const { data, error, isLoading } = useAgents();
  const [drawer, setDrawer] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const close = useCallback(() => setDrawer(null), []);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <h1>Агенты</h1>
      <ErrorBox error={error} />
      <div className="grid">
        {data.map((a) => {
          const st = AGENT_STATUS[a.status];
          return (
            <div className={`card agent ${a.controls.disabled ? 'agent-off' : ''}`} key={a.id}>
              <div className="row between">
                <div>
                  <h2>{a.name}</h2>
                  <div className="muted small">{a.role}</div>
                </div>
                <div className="stack end-items">
                  <Pill tone={st.tone}>{st.label}</Pill>
                  {a.status === 'working' && (a.controls.paused || a.controls.allPaused) && (
                    <Pill tone="muted">⏸ пауза после текущего запуска</Pill>
                  )}
                </div>
              </div>
              <p className="small">{a.description}</p>
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
                    <Link to={`/tasks/${a.currentTask.id}`}>{a.currentTask.title ?? 'задача'}</Link>
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
                  <code>{a.promptVersion}</code>
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
              <div className="row">
                <PauseButton agentId={a.id} paused={a.controls.paused} name={a.name} />
                <Button onClick={() => setDrawer({ id: a.id, tab: 'test' })}>Тест</Button>
                <Button onClick={() => setDrawer({ id: a.id, tab: 'overview' })}>Настроить</Button>
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
