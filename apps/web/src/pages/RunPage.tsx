import { useState } from 'react';
import { api } from '../api';
import { dateTime, usd } from '../format';
import { useRun } from '../queries';
import { Button, ErrorBox, Link, Loading } from '../ui';

const json = (v: unknown) => JSON.stringify(v, null, 2);

function FullText({ callId }: { callId: string }) {
  const [text, setText] = useState<{ request: unknown; response: unknown } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (text) {
    return (
      <div className="stack">
        <details open>
          <summary>Запрос</summary>
          <pre>{json(text.request)}</pre>
        </details>
        <details open>
          <summary>Ответ</summary>
          <pre>{json(text.response)}</pre>
        </details>
      </div>
    );
  }
  return (
    <>
      <Button
        busy={busy}
        onClick={() => {
          setBusy(true);
          api
            .get<{ request: unknown; response: unknown }>(`/api/llm-calls/${callId}/text`)
            .then(setText, setError)
            .finally(() => setBusy(false));
        }}
      >
        Показать полный текст
      </Button>
      <ErrorBox error={error} />
    </>
  );
}

export function RunPage({ id }: { id: string }) {
  const { data, error, isLoading } = useRun(id);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const { run } = data;
  const total = data.llmCalls.reduce((s, c) => s + c.costUsd, 0);
  return (
    <>
      <div className="crumbs small">
        {data.task ? (
          <>
            <Link to="/tasks">Задачи</Link> /{' '}
            <Link to={`/tasks/${data.task.id}`}>{data.task.title}</Link> /
          </>
        ) : null}
      </div>
      <h1>
        Запуск: {run.agent} <span className="muted small">{run.status}</span>
      </h1>
      <ErrorBox error={error} />
      <div className="row wrap small muted">
        <span>попытка {run.attempt}</span>
        <span>· создан {dateTime(run.createdAt)}</span>
        <span>· начат {dateTime(run.startedAt)}</span>
        <span>· завершён {dateTime(run.finishedAt)}</span>
        <span>· стоимость {usd(total)}</span>
      </div>

      <section className="card">
        <h2>Агенты в этом запуске</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Агент</th>
              <th>Статус</th>
              <th>Версия промпта</th>
              <th>Модель</th>
              <th>Стоимость</th>
              <th>Время</th>
            </tr>
          </thead>
          <tbody>
            {data.invocations.map((i, n) => (
              <tr key={n}>
                <td>{i.agent}</td>
                <td>{i.status}</td>
                <td>
                  <code>{i.promptVersion}</code>
                </td>
                <td>
                  <code>{i.model}</code>
                </td>
                <td>{usd(i.costUsd)}</td>
                <td>{i.latencyMs !== null ? `${(i.latencyMs / 1000).toFixed(1)} c` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Вызовы модели</h2>
        {data.llmCalls.length === 0 && <div className="muted">Вызовов нет.</div>}
        {data.llmCalls.map((c) => (
          <div className="llm-call" key={c.id}>
            <div className="row wrap small">
              <b>{c.agent}</b>
              <span>попытка {c.attempt}</span>
              <span>{c.status}</span>
              <span>
                модель <code>{c.requestedModel}</code>
                {c.servedModel && c.servedModel !== c.requestedModel
                  ? ` (ответила ${c.servedModel})`
                  : ''}
              </span>
              <span>
                токены: вход {c.inputTokens ?? '—'}, выход {c.outputTokens ?? '—'}, кэш чтение{' '}
                {c.cacheReadTokens ?? '—'}, кэш запись {c.cacheWriteTokens ?? '—'}
              </span>
              <span>{usd(c.costUsd)}</span>
              <span>{c.latencyMs !== null ? `${(c.latencyMs / 1000).toFixed(1)} c` : ''}</span>
              <span className="muted">{c.promptVersion}</span>
            </div>
            {c.error ? <pre className="small">{json(c.error)}</pre> : null}
            {c.hasFullText ? (
              <FullText callId={c.id} />
            ) : (
              <div className="muted small">
                Полный текст не сохранялся (LLM_STORE_FULL_TEXT=false).
              </div>
            )}
          </div>
        ))}
      </section>

      {data.artifacts.length > 0 && (
        <section className="card">
          <h2>Результаты</h2>
          <ul>
            {data.artifacts.map((a) => (
              <li key={a.id}>
                {a.slot} v{a.version} <span className="muted small">{a.promptVersion}</span>
                {a.critic ? ` — Critic: ${a.critic.passed ? 'принято' : 'замечания'}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <details>
          <summary>Вход запуска</summary>
          <pre>{json(run.input)}</pre>
        </details>
        {run.output !== null && run.output !== undefined && (
          <details>
            <summary>Выход запуска</summary>
            <pre>{json(run.output)}</pre>
          </details>
        )}
        {run.error !== null && run.error !== undefined && (
          <details open>
            <summary>Ошибка</summary>
            <pre>{json(run.error)}</pre>
          </details>
        )}
      </section>
    </>
  );
}
