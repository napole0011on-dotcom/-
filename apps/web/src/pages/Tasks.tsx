import { BOARD_COLUMNS, STATUS_LABEL, STATUS_TONE, ago, usd } from '../format';
import { useTasks } from '../queries';
import { Empty, ErrorBox, Link, Loading, Pill } from '../ui';

export function Tasks() {
  const { data, error, isLoading } = useTasks();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <div className="row between">
        <h1>Задачи</h1>
        <Link className="btn btn-primary" to="/tasks/new">
          + Новая задача
        </Link>
      </div>
      <ErrorBox error={error} />
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          const items = data.filter((t) => col.statuses.includes(t.status));
          return (
            <section className="column" key={col.title}>
              <h3>
                {col.title} <span className="muted">{items.length}</span>
              </h3>
              {items.length === 0 && <Empty>пусто</Empty>}
              {items.map((t) => (
                <Link key={t.id} to={`/tasks/${t.id}`} className="card task-card">
                  <div className="task-title">{t.title}</div>
                  <div className="row between small">
                    <Pill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Pill>
                    <span className="muted">{usd(t.spentUsd)}</span>
                  </div>
                  {t.paused && <div className="paused small">⏸ на паузе: {t.pauseReason}</div>}
                  {t.waitingFor && (
                    <div className="paused small">⏳ ждёт агента: {t.waitingFor}</div>
                  )}
                  <div className="muted small">{ago(t.statusChangedAt)}</div>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
