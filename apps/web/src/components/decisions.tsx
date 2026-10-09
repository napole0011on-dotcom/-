import { useState } from 'react';
import { api, type ItemView, type Plan, type PlanEstimate } from '../api';
import { CHECK_LABEL, PLATFORM_LABEL, usd } from '../format';
import { Button, ConfirmButton, Pill, useAction } from '../ui';

export function PlanView({ plan, estimate }: { plan: Plan; estimate?: PlanEstimate }) {
  return (
    <div className="plan">
      <p>{plan.summary}</p>
      <ol className="deliverables">
        {plan.deliverables.map((d) => (
          <li key={d.id}>
            <b>{PLATFORM_LABEL[d.platform]}</b> — {d.topic}
            <div className="muted small">
              Цель: {d.goal}
              {d.notes ? ` · ${d.notes}` : ''}
            </div>
          </li>
        ))}
      </ol>
      {plan.assumptions.length > 0 && (
        <div className="small">
          <b>Допущения:</b> {plan.assumptions.join('; ')}
        </div>
      )}
      {plan.questions.length > 0 && (
        <div className="small">
          <b>Вопросы к вам:</b> {plan.questions.join('; ')}
        </div>
      )}
      {estimate && (
        <div className="estimate small">
          Ожидаемо {usd(estimate.expectedUsd)}, максимум {usd(estimate.maxUsd)}, около{' '}
          {estimate.expectedMinutes} мин
        </div>
      )}
    </div>
  );
}

/** Gate 1: approve / change with a comment / cancel. Same Workflow call as the Telegram buttons. */
export function PlanDecision({ taskId }: { taskId: string }) {
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const decide = useAction((v: { action: 'approve' | 'change' | 'cancel'; comment?: string }) =>
    api.post(`/api/tasks/${taskId}/plan`, v),
  );
  return (
    <div className="decision">
      {editing ? (
        <div className="stack">
          <textarea
            autoFocus
            rows={3}
            value={comment}
            placeholder="Что изменить в плане?"
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="row">
            <Button
              variant="primary"
              disabled={!comment.trim()}
              busy={decide.isPending}
              onClick={() => decide.mutate({ action: 'change', comment: comment.trim() })}
            >
              Отправить CEO
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button
            variant="primary"
            busy={decide.isPending}
            onClick={() => decide.mutate({ action: 'approve' })}
          >
            ✅ Утвердить план
          </Button>
          <Button onClick={() => setEditing(true)}>✏️ Изменить</Button>
          <ConfirmButton
            label="✖️ Отменить задачу"
            variant="ghost"
            title="Отменить задачу?"
            text="План не будет выполнен. Это действие нельзя отменить."
            confirmLabel="Да, отменить"
            danger
            onConfirm={() => decide.mutate({ action: 'cancel' })}
          />
        </div>
      )}
    </div>
  );
}

export function CopyItemView({ item }: { item: ItemView }) {
  const { deliverable: d, item: copy, critic } = item;
  return (
    <div className="copy">
      <div className="copy-head">
        <b>{PLATFORM_LABEL[d.platform]}</b> — {d.topic}
        <span className="muted small"> · версия {item.version}</span>
        {critic.passed ? (
          <Pill tone="success">Critic: принято</Pill>
        ) : item.criticRejected ? (
          <Pill tone="danger">Critic: не согласен после 2 правок</Pill>
        ) : (
          <Pill tone="accent">Critic: замечания</Pill>
        )}
      </div>
      {item.ownerComment && (
        <div className="owner-comment small">Ваш комментарий учтён: «{item.ownerComment}»</div>
      )}
      <div className="variants">
        {copy.variants.map((v, i) => (
          <div className="variant" key={i}>
            <div className="variant-n">
              Вариант {i + 1} <span className="muted small">· {v.angle}</span>
            </div>
            <div className="hook">{v.hook}</div>
            <div className="body">{v.body}</div>
            <div className="cta">{v.cta}</div>
          </div>
        ))}
      </div>
      {copy.slides && (
        <details>
          <summary>Слайды ({copy.slides.length})</summary>
          <ol>
            {copy.slides.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
      {copy.reelsScript && (
        <details>
          <summary>Сценарий Reels</summary>
          <table className="table small">
            <tbody>
              {copy.reelsScript.map((s, i) => (
                <tr key={i}>
                  <td>
                    {s.fromSec}–{s.toSec} c
                  </td>
                  <td>{s.visual}</td>
                  <td>{s.voiceover}</td>
                  <td>{s.onScreenText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <details className="critic">
        <summary>Проверка Critic (раунд {item.criticRound})</summary>
        <p className="small">{critic.summary}</p>
        <ul className="small checks">
          {Object.entries(critic.checks).map(([k, c]) => (
            <li key={k}>
              {c.ok ? '✅' : '⚠️'} {CHECK_LABEL[k] ?? k}
              {c.comment ? ` — ${c.comment}` : ''}
            </li>
          ))}
        </ul>
        {critic.issues.length > 0 && (
          <ul className="small">
            {critic.issues.map((x, i) => (
              <li key={i}>
                {x.variant ? `Вариант ${x.variant}: ` : ''}
                {x.problem} → {x.fix}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

/** Gate 2 per item: approve a variant / all, revise with a comment, regenerate. */
export function ItemDecision({ artifactId }: { artifactId: string }) {
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const decide = useAction(
    (v: { action: 'approve' | 'revise' | 'regenerate'; variant?: number; comment?: string }) =>
      api.post(`/api/artifacts/${artifactId}/decision`, v),
  );
  if (editing) {
    return (
      <div className="decision stack">
        <textarea
          autoFocus
          rows={3}
          value={comment}
          placeholder="Что поправить?"
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="row">
          <Button
            variant="primary"
            disabled={!comment.trim()}
            busy={decide.isPending}
            onClick={() => decide.mutate({ action: 'revise', comment: comment.trim() })}
          >
            Отправить на правку
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Отмена
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="decision row">
      {[1, 2, 3].map((n) => (
        <Button
          key={n}
          variant="primary"
          busy={decide.isPending}
          onClick={() => decide.mutate({ action: 'approve', variant: n })}
        >
          ✅ {n}
        </Button>
      ))}
      <Button busy={decide.isPending} onClick={() => decide.mutate({ action: 'approve' })}>
        ✅ все
      </Button>
      <Button onClick={() => setEditing(true)}>✏️ Правка с комментарием</Button>
      <Button busy={decide.isPending} onClick={() => decide.mutate({ action: 'regenerate' })}>
        🔄 Заново
      </Button>
    </div>
  );
}

/** Whole package: approve the rest, or reject it (with confirmation; can be undone until export). */
export function PackageActions({
  taskId,
  canReject,
  canApproveAll,
}: {
  taskId: string;
  canReject: boolean;
  canApproveAll: boolean;
}) {
  const approveAll = useAction(() => api.post(`/api/tasks/${taskId}/approve-all`));
  const reject = useAction((comment: string) =>
    api.post(`/api/tasks/${taskId}/reject`, comment ? { comment } : {}),
  );
  return (
    <div className="row">
      {canApproveAll && (
        <Button variant="primary" busy={approveAll.isPending} onClick={() => approveAll.mutate()}>
          ✅ Утвердить всё оставшееся
        </Button>
      )}
      {canReject && (
        <ConfirmButton
          label="✖️ Отклонить пакет"
          variant="ghost"
          title="Отклонить пакет?"
          text="Задача перейдёт в «отклонено», экспорта не будет. Пока пакет не экспортирован, его можно вернуть на согласование."
          confirmLabel="Да, отклонить"
          danger
          withComment
          commentPlaceholder="Почему отклоняете (необязательно)"
          busy={reject.isPending}
          onConfirm={(c) => reject.mutate(c)}
        />
      )}
    </div>
  );
}
