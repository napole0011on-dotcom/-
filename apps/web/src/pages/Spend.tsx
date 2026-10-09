import { api, type BudgetLine } from '../api';
import { dateTime, usd } from '../format';
import { useSpend } from '../queries';
import { Button, Empty, ErrorBox, Link, Loading, useAction } from '../ui';

function Meter({ title, line }: { title: string; line: BudgetLine }) {
  const ratio = line.limitUsd > 0 ? Math.min(1, line.spentUsd / line.limitUsd) : 0;
  return (
    <div className="card meter-card">
      <div className="row between">
        <h2>{title}</h2>
        <span>
          <b>{usd(line.spentUsd)}</b> <span className="muted">из {usd(line.limitUsd)}</span>
        </span>
      </div>
      <div className={`meter meter-${line.level}`}>
        <div style={{ width: `${ratio * 100}%` }} />
      </div>
      {line.level === 'warn' && <div className="small warn">Больше 80% лимита</div>}
      {line.level === 'over' && (
        <div className="small danger">Лимит исчерпан — новые вызовы на паузе</div>
      )}
    </div>
  );
}

function BudgetButtons({ taskId }: { taskId: string }) {
  const add = useAction((extraUsd: 1 | 5) => api.post(`/api/tasks/${taskId}/budget`, { extraUsd }));
  return (
    <div className="row">
      <Button variant="primary" busy={add.isPending} onClick={() => add.mutate(1)}>
        +$1
      </Button>
      <Button busy={add.isPending} onClick={() => add.mutate(5)}>
        +$5
      </Button>
    </div>
  );
}

export function Spend() {
  const { data, error, isLoading } = useSpend();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <h1>Расходы</h1>
      <ErrorBox error={error} />
      <div className="grid two">
        <Meter title="Сегодня" line={data.day} />
        <Meter title="Этот месяц" line={data.month} />
      </div>
      <div className="muted small">
        Лимит на задачу {usd(data.taskLimitUsd)}. Учёт включает резервы идущих вызовов.
      </div>

      {data.pausedTasks.length > 0 && (
        <section className="card warn-card">
          <h2>На паузе по бюджету</h2>
          {data.pausedTasks.map((t) => (
            <div className="row between" key={t.id}>
              <Link to={`/tasks/${t.id}`}>{t.title}</Link>
              <span className="muted small">{t.reason}</span>
              <BudgetButtons taskId={t.id} />
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>По агентам (этот месяц)</h2>
        {data.byAgent.length === 0 ? (
          <Empty>Расходов ещё нет.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Агент</th>
                <th>Сегодня</th>
                <th>Месяц</th>
                <th>Вызовов</th>
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((a) => (
                <tr key={a.agent ?? '-'}>
                  <td>{a.agent ?? '—'}</td>
                  <td>{usd(a.todayUsd)}</td>
                  <td>{usd(a.monthUsd)}</td>
                  <td>{a.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Сверки с кошельком</h2>
        {data.reconciliations.length === 0 ? (
          <Empty>
            Сверок не было. В Telegram: <code>/reconcile 12.34</code> (баланс из кабинета
            провайдера).
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Провайдер</th>
                <th>Баланс</th>
                <th>Списано кошельком</th>
                <th>По нашему учёту</th>
              </tr>
            </thead>
            <tbody>
              {data.reconciliations.map((r, i) => (
                <tr key={i}>
                  <td>{dateTime(r.at)}</td>
                  <td>{r.provider}</td>
                  <td>{usd(r.balanceUsd)}</td>
                  <td>{r.walletSpentUsd === null ? 'база' : usd(r.walletSpentUsd)}</td>
                  <td>{usd(r.recordedRawUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
