import { STATUS_LABEL, ago, usd } from '../format';
import { useApprovals } from '../queries';
import { Empty, ErrorBox, Link, Loading, Pill } from '../ui';
import {
  CopyItemView,
  ItemDecision,
  NodeDecision,
  NodeItemView,
  PackageActions,
  PlanDecision,
  PlanView,
} from '../components/decisions';

export function Approvals() {
  const { data, error, isLoading } = useApprovals();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <>
      <div className="page-head">
        <h1>Согласование</h1>
      </div>
      <ErrorBox error={error} />
      {data.count === 0 && <Empty>Ничего не ждёт вашего решения.</Empty>}

      {data.plans.map((p) => (
        <section className="card" key={p.taskId}>
          <div className="row between wrap">
            <h2>
              План: <Link to={`/tasks/${p.taskId}`}>{p.title}</Link>{' '}
              <span className="muted small">v{p.version}</span>
            </h2>
            <span className="muted small">ждёт {ago(p.waitingSince)}</span>
          </div>
          <PlanView plan={p.plan} estimate={p.estimate} />
          <div className="muted small">
            Потрачено на задачу {usd(p.spentUsd)} из {usd(p.taskBudgetUsd)}
          </div>
          <PlanDecision taskId={p.taskId} />
        </section>
      ))}

      {data.packages.map((p) => (
        <section className="card" key={p.taskId}>
          <div className="row between wrap">
            <h2>
              Пакет: <Link to={`/tasks/${p.taskId}`}>{p.title}</Link>
            </h2>
            <div className="row">
              <Pill tone={p.status === 'awaiting_final_approval' ? 'accent' : 'info'}>
                {STATUS_LABEL[p.status]}
              </Pill>
              <span className="muted small">
                ждут решения {p.pendingCount} из {p.totalCount}
              </span>
            </div>
          </div>
          {p.items.map((it) => (
            <div className="copy-block" key={it.artifactId}>
              <CopyItemView item={it} />
              <ItemDecision artifactId={it.artifactId} />
            </div>
          ))}
          {p.nodeItems.map((it) => (
            <div className="copy-block" key={it.artifactId}>
              <NodeItemView item={it} />
              <NodeDecision artifactId={it.artifactId} />
            </div>
          ))}
          {p.items.length === 0 && p.nodeItems.length === 0 && (
            <Empty>Результаты в доработке — новая версия появится здесь автоматически.</Empty>
          )}
          <PackageActions
            taskId={p.taskId}
            canReject={p.canReject}
            canApproveAll={p.canReject && p.items.length + p.nodeItems.length > 0}
          />
        </section>
      ))}
    </>
  );
}
