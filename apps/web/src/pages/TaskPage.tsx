import { api, type TaskDetail } from '../api';
import { DECISION_LABEL, STATUS_LABEL, STATUS_TONE, actorLabel, dateTime, usd } from '../format';
import { useTask } from '../queries';
import { Button, ConfirmButton, ErrorBox, Link, Loading, Pill, useAction } from '../ui';
import {
  CopyItemView,
  ItemDecision,
  PackageActions,
  PlanDecision,
  PlanView,
} from '../components/decisions';

type Copy = TaskDetail['copies'][number];

/** Latest version per slot, older versions kept for the history block. */
function groupCopies(copies: Copy[]) {
  const bySlot = new Map<string, Copy[]>();
  for (const c of copies) bySlot.set(c.slot, [...(bySlot.get(c.slot) ?? []), c]);
  return [...bySlot.values()].map((vs) => {
    const sorted = [...vs].sort((a, b) => b.version - a.version);
    return { latest: sorted[0]!, older: sorted.slice(1) };
  });
}

export function TaskPage({ id }: { id: string }) {
  const { data, error, isLoading } = useTask(id);
  const reopen = useAction(() => api.post(`/api/tasks/${id}/reopen`));
  const cancel = useAction(() => api.post(`/api/tasks/${id}/cancel`));
  const budget = useAction((extraUsd: 1 | 5) => api.post(`/api/tasks/${id}/budget`, { extraUsd }));
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const { task, actions } = data;
  const plan = data.plans.at(-1);
  const groups = groupCopies(data.copies);
  const budgetPaused = task.paused && task.pauseReason?.startsWith('budget:');

  return (
    <>
      <div className="crumbs small">
        <Link to="/tasks">Задачи</Link> /
      </div>
      <div className="row between wrap">
        <h1>{task.title}</h1>
        <Pill tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Pill>
      </div>
      <ErrorBox error={error} />
      <div className="row wrap small muted">
        <span>
          Потрачено {usd(task.spentUsd)} из {usd(task.budgetUsd)}
        </span>
        <span>· создана {dateTime(task.createdAt)}</span>
        <span>· статус с {dateTime(task.statusChangedAt)}</span>
      </div>

      {task.paused && (
        <div className="card warn-card">
          ⏸ Задача на паузе: {task.pauseReason}
          {budgetPaused && (
            <div className="row">
              <Button variant="primary" busy={budget.isPending} onClick={() => budget.mutate(1)}>
                Разрешить +$1
              </Button>
              <Button busy={budget.isPending} onClick={() => budget.mutate(5)}>
                Разрешить +$5
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="row wrap">
        {actions.reopenPackage && (
          <Button variant="primary" busy={reopen.isPending} onClick={() => reopen.mutate()}>
            ↩️ Вернуть на согласование
          </Button>
        )}
        {actions.cancel && (
          <ConfirmButton
            label="Отменить задачу"
            variant="ghost"
            title="Отменить задачу?"
            text="Работа по задаче остановится. Это действие нельзя отменить."
            confirmLabel="Да, отменить"
            danger
            busy={cancel.isPending}
            onConfirm={() => cancel.mutate()}
          />
        )}
      </div>

      <section className="card">
        <h2>Бриф</h2>
        <p className="pre">{task.brief}</p>
      </section>

      {plan && (
        <section className="card">
          <h2>
            План v{plan.version}{' '}
            <span className="muted small">
              {plan.promptVersion} · {plan.model}
            </span>
          </h2>
          <PlanView plan={plan.plan} />
          {actions.decidePlan && <PlanDecision taskId={task.id} />}
          {data.plans.length > 1 && (
            <details>
              <summary>Предыдущие версии плана ({data.plans.length - 1})</summary>
              {data.plans.slice(0, -1).map((p) => (
                <div key={p.id} className="older">
                  <b>v{p.version}</b>
                  <PlanView plan={p.plan} />
                </div>
              ))}
            </details>
          )}
        </section>
      )}

      {groups.length > 0 && (
        <section className="card">
          <div className="row between wrap">
            <h2>Тексты</h2>
            {(actions.rejectPackage || actions.decideItems) && (
              <PackageActions
                taskId={task.id}
                canReject={actions.rejectPackage}
                canApproveAll={actions.rejectPackage}
              />
            )}
          </div>
          {groups.map(({ latest, older }) => (
            <div key={latest.slot} className="copy-block">
              <CopyItemView item={latest} />
              {latest.decision ? (
                <div className="small decision-note">
                  {DECISION_LABEL[latest.decision.decision]}
                  {latest.decision.choice ? ` (вариант ${latest.decision.choice})` : ''} —{' '}
                  {actorLabel(latest.decision.by)}, {dateTime(latest.decision.at)}
                  {latest.decision.comment ? ` · «${latest.decision.comment}»` : ''}
                </div>
              ) : (
                actions.decideItems && <ItemDecision artifactId={latest.artifactId} />
              )}
              {latest.runId && (
                <div className="small">
                  <Link to={`/runs/${latest.runId}`}>Запуск</Link>{' '}
                  <span className="muted">
                    · {latest.promptVersion} · {latest.model}
                  </span>
                </div>
              )}
              {older.length > 0 && (
                <details>
                  <summary>Предыдущие версии ({older.length})</summary>
                  {older.map((o) => (
                    <div key={o.artifactId} className="older">
                      <CopyItemView item={o} />
                    </div>
                  ))}
                </details>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Запуски агентов</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Агент</th>
              <th>Статус</th>
              <th>Попытка</th>
              <th>Начат</th>
              <th>Ошибка</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>{r.agent}</Link>
                </td>
                <td>{r.status}</td>
                <td>{r.attempt}</td>
                <td>{dateTime(r.createdAt)}</td>
                <td className="small">{r.error?.message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>История</h2>
        <table className="table small">
          <tbody>
            {data.history.map((h, i) => (
              <tr key={i}>
                <td>{dateTime(h.at)}</td>
                <td>{actorLabel(h.actor)}</td>
                <td>{h.action}</td>
                <td>
                  {h.from && h.to
                    ? `${STATUS_LABEL[h.from as keyof typeof STATUS_LABEL] ?? h.from} → ${STATUS_LABEL[h.to as keyof typeof STATUS_LABEL] ?? h.to}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
