import { AGENT_STATUS, ago, percent, usd } from '../format';
import { useAgents } from '../queries';
import { Button, ErrorBox, Link, Loading, Pill } from '../ui';

const STEP2 = 'Будет в шаге 2: управление агентами';

export function Agents() {
  const { data, error, isLoading } = useAgents();
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
            <div className="card agent" key={a.id}>
              <div className="row between">
                <div>
                  <h2>{a.name}</h2>
                  <div className="muted small">{a.role}</div>
                </div>
                <Pill tone={st.tone}>{st.label}</Pill>
              </div>
              <p className="small">{a.description}</p>
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
                  <span className="muted small">из {a.model.source}</span>
                </dd>
                <dt>Промпт</dt>
                <dd>
                  <code>{a.promptVersion}</code>
                </dd>
              </dl>
              <div className="row">
                <Button disabled title={STEP2}>
                  Пауза
                </Button>
                <Button disabled title={STEP2}>
                  Тест
                </Button>
                <Button disabled title={STEP2}>
                  Настроить
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
