import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ApiError,
  api,
  type AgentSettings,
  type AgentTestResult,
  type PromptVersion,
} from '../api';
import { collapseDiff, diffStats, lineDiff } from '../diff';
import { AGENT_STATUS, actorLabel, dateTime } from '../format';
import { useAgentSettings } from '../queries';
import { Button, ConfirmButton, ErrorBox, Loading, Pill, useAction } from '../ui';

export type DrawerTab = 'overview' | 'model' | 'prompt' | 'test';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'model', label: 'Модель' },
  { id: 'prompt', label: 'Промпт' },
  { id: 'test', label: 'Тест' },
];

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Same rules as validatePromptText on the server (the server re-checks). */
export function promptProblem(text: string, maxBytes: number): string | null {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return 'Промпт пустой';
  if (bytes(t) > maxBytes) return `Промпт длиннее ${Math.round(maxBytes / 1024)} КБ`;
  if (/^---\s*\n/.test(t)) return 'Уберите блок «---» в начале: версия назначается автоматически';
  return null;
}

export function AgentDrawer({
  agentId,
  tab,
  onTab,
  onClose,
}: {
  agentId: string;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
}) {
  const { data, error, isLoading } = useAgentSettings(agentId);
  // The editor draft is shared by the "Промпт" and "Тест" tabs.
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Настройки агента">
        <div className="row between">
          <h2>{data ? `${data.agent.name} — настройки` : 'Настройки агента'}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </Button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.id === 'prompt' && data?.prompts.pendingFile ? ' •' : ''}
            </button>
          ))}
        </div>
        {isLoading && <Loading />}
        <ErrorBox error={error} />
        {data && tab === 'overview' && <Overview s={data} />}
        {data && tab === 'model' && <ModelTab s={data} />}
        {data && tab === 'prompt' && <PromptTab s={data} draft={draft} setDraft={setDraft} />}
        {data && tab === 'test' && <TestTab s={data} draft={draft} />}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ Обзор

export function PauseButton({
  agentId,
  paused,
  name,
}: {
  agentId: string;
  paused: boolean;
  name: string;
}) {
  const act = useAction((p: boolean) =>
    api.post(`/api/agents/${agentId}/${p ? 'pause' : 'resume'}`),
  );
  return paused ? (
    <Button variant="primary" busy={act.isPending} onClick={() => act.mutate(false)}>
      ▶ Продолжить
    </Button>
  ) : (
    <Button
      busy={act.isPending}
      title={`Новые запуски ${name} будут ждать в очереди, текущий доработает`}
      onClick={() => act.mutate(true)}
    >
      ⏸ Пауза
    </Button>
  );
}

function Overview({ s }: { s: AgentSettings }) {
  const toggle = useAction((disable: boolean) =>
    api.post(`/api/agents/${s.agent.id}/${disable ? 'disable' : 'enable'}`),
  );
  const status = s.controls.disabled
    ? AGENT_STATUS.disabled
    : s.controls.paused
      ? AGENT_STATUS.paused
      : { label: 'работает по расписанию очереди', tone: 'success' as const };
  return (
    <div className="stack">
      <p className="small">{s.agent.description}</p>
      <div className="row wrap">
        <Pill tone={status.tone}>{status.label}</Pill>
        {s.controls.allPaused && <Pill tone="danger">остановлено всё</Pill>}
      </div>
      {s.controls.updatedBy && (
        <div className="muted small">
          Последнее изменение: {actorLabel(s.controls.updatedBy)}, {dateTime(s.controls.updatedAt)}
        </div>
      )}
      <div className="row wrap">
        <PauseButton agentId={s.agent.id} paused={s.controls.paused} name={s.agent.name} />
        {s.controls.disabled ? (
          <Button busy={toggle.isPending} onClick={() => toggle.mutate(false)}>
            Включить
          </Button>
        ) : (
          <ConfirmButton
            label="Выключить"
            variant="ghost"
            title={`Выключить ${s.agent.name}?`}
            text="Запуски, которым нужен этот агент, будут ждать в очереди, пока вы его не включите. Текущий запуск доработает."
            confirmLabel="Да, выключить"
            danger
            busy={toggle.isPending}
            onConfirm={() => toggle.mutate(true)}
          />
        )}
      </div>
      <div className="muted small">
        Пауза — временно; «Выключить» — до явного включения. В обоих случаях задачи не теряются:
        запуски ждут в очереди и продолжатся автоматически.
      </div>
      <dl className="facts">
        <dt>Модель</dt>
        <dd>
          <code>{s.model.name}</code> <span className="muted small">из {s.model.source}</span>
        </dd>
        <dt>Промпт</dt>
        <dd>
          <code>{s.prompts.active.label}</code>
          {s.prompts.pendingFile && (
            <span className="warn small"> · есть новая версия из файла</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ Модель

function ModelTab({ s }: { s: AgentSettings }) {
  const [model, setModel] = useState(s.model.name);
  const save = useAction((m: string) => api.post(`/api/agents/${s.agent.id}/model`, { model: m }));
  const reset = useAction(() => api.post(`/api/agents/${s.agent.id}/model/reset`));
  const listed = s.model.allowed.includes(s.model.name);
  return (
    <div className="stack">
      <div>
        Сейчас: <code>{s.model.name}</code>{' '}
        <Pill tone={s.model.source === 'panel' ? 'accent' : 'neutral'}>
          {s.model.source === 'panel' ? 'задана в панели' : 'из .env'}
        </Pill>
      </div>
      {s.model.ignoredOverride && (
        <div className="error-box">
          В панели была выбрана модель {s.model.ignoredOverride}, но её нет в прайс-листе текущего
          провайдера, поэтому используется модель из .env. Нажмите «Сбросить к .env», чтобы убрать
          старую настройку, или выберите модель из списка.
        </div>
      )}
      {!listed && (
        <div className="error-box">
          Модели {s.model.name} нет в прайс-листе — её стоимость считается по максимальной ставке.
        </div>
      )}
      <label htmlFor="model">Модель (только из прайс-листа провайдера)</label>
      <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
        {!listed && <option value={s.model.name}>{s.model.name} (нет в прайсе)</option>}
        {s.model.allowed.map((m) => (
          <option key={m} value={m}>
            {m}
            {m === s.model.env ? ' — как в .env' : ''}
          </option>
        ))}
      </select>
      <div className="row wrap">
        <Button
          variant="primary"
          disabled={model === s.model.name || !s.model.allowed.includes(model)}
          busy={save.isPending}
          onClick={() => save.mutate(model)}
        >
          Сохранить
        </Button>
        {(s.model.source === 'panel' || s.model.ignoredOverride) && (
          <ConfirmButton
            label="Сбросить к .env"
            variant="ghost"
            title="Сбросить модель к .env?"
            text={
              <>
                Модель снова будет браться из <code>.env</code>: <code>{s.model.env}</code>.
              </>
            }
            confirmLabel="Да, сбросить"
            busy={reset.isPending}
            onConfirm={() => {
              setModel(s.model.env);
              reset.mutate();
            }}
          />
        )}
      </div>
      <div className="muted small">
        Новая модель действует со следующего запуска агента. Каждое изменение записывается в журнал
        (кто, когда, с какой на какую).
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Промпт

function Diff({ before, after }: { before: string; after: string }) {
  const d = lineDiff(before, after);
  const st = diffStats(d);
  return (
    <div className="stack">
      <div className="small muted">
        +{st.added} строк, −{st.removed} строк
      </div>
      <pre className="diff">
        {collapseDiff(d).map((l, i) =>
          l.kind === 'skip' ? (
            <div key={i} className="diff-skip">
              … {l.count} строк без изменений …
            </div>
          ) : (
            <div key={i} className={`diff-${l.kind}`}>
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
              {l.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

function ActivateButton({
  agentId,
  v,
  active,
  label,
}: {
  agentId: string;
  v: PromptVersion;
  active: PromptVersion;
  label: string;
}) {
  const act = useAction(() => api.post(`/api/agents/${agentId}/prompts/${v.id}/activate`));
  if (v.version < active.version) {
    return (
      <ConfirmButton
        label={label}
        title={`Вернуть старую версию ${v.label}?`}
        text={`Сейчас активна ${active.label}. Новые запуски пойдут со старой версией ${v.label}; вернуться можно в один клик.`}
        confirmLabel="Да, включить"
        busy={act.isPending}
        onConfirm={() => act.mutate()}
      />
    );
  }
  return (
    <Button variant="primary" busy={act.isPending} onClick={() => act.mutate()}>
      {label}
    </Button>
  );
}

function PromptTab({
  s,
  draft,
  setDraft,
}: {
  s: AgentSettings;
  draft: string | null;
  setDraft: (t: string | null) => void;
}) {
  const active = s.prompts.active;
  const text = draft ?? active.text;
  const dirty = draft !== null && draft !== active.text;
  const problem = promptProblem(text, s.prompts.maxBytes);
  const [showDiff, setShowDiff] = useState(false);
  const [compare, setCompare] = useState<PromptVersion | null>(null);
  const save = useAction(
    (t: string) => api.post(`/api/agents/${s.agent.id}/prompts`, { text: t }),
    (r) => r.ok && setDraft(null),
  );
  const size = bytes(text);
  return (
    <div className="stack">
      {s.prompts.pendingFile && (
        <div className="card warn-card stack">
          <b>Есть новая версия из файла: {s.prompts.pendingFile.label}</b>
          <div className="small">
            Файл <code>prompts/{s.agent.id}.md</code> изменился. Версия сохранена, но не включена —
            решаете вы.
          </div>
          <Diff before={active.text} after={s.prompts.pendingFile.text} />
          <div className="row">
            <ActivateButton
              agentId={s.agent.id}
              v={s.prompts.pendingFile}
              active={active}
              label="Включить версию из файла"
            />
          </div>
        </div>
      )}
      <div className="row between wrap">
        <div>
          Активна: <code>{active.label}</code>{' '}
          <span className="muted small">
            ({active.source === 'file' ? 'из файла' : 'из панели'}, {dateTime(active.createdAt)})
          </span>
        </div>
        <span className={`small ${size > s.prompts.maxBytes ? 'danger' : 'muted'}`}>
          {(size / 1024).toFixed(1)} / {s.prompts.maxBytes / 1024} КБ
        </span>
      </div>
      <textarea
        className="prompt-editor"
        rows={18}
        spellCheck={false}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty && problem && <div className="error-box">{problem}</div>}
      <div className="row wrap">
        <Button
          variant="primary"
          disabled={!dirty || !!problem}
          busy={save.isPending}
          onClick={() => save.mutate(text)}
        >
          Сохранить как новую версию
        </Button>
        <Button disabled={!dirty} onClick={() => setShowDiff((x) => !x)}>
          {showDiff ? 'Скрыть изменения' : 'Показать изменения'}
        </Button>
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
          Отменить правки
        </Button>
      </div>
      {dirty && showDiff && <Diff before={active.text} after={text} />}
      <div className="muted small">
        Сохранение создаёт новую версию и сразу делает её активной для новых запусков. Версия
        промпта записывается в каждый вызов модели и каждый результат.
      </div>

      <h3>Версии</h3>
      <table className="table small">
        <tbody>
          {s.prompts.versions.map((v) => (
            <tr key={v.id}>
              <td>
                <code>{v.label}</code> {v.active && <Pill tone="success">активна</Pill>}
              </td>
              <td>
                {v.source === 'file'
                  ? `файл${v.fileVersion ? ` (v${v.fileVersion})` : ''}`
                  : 'панель'}
              </td>
              <td>{actorLabel(v.createdBy)}</td>
              <td>{dateTime(v.createdAt)}</td>
              <td className="row end">
                {!v.active && (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => setCompare(compare?.id === v.id ? null : v)}
                    >
                      Сравнить
                    </Button>
                    <ActivateButton
                      agentId={s.agent.id}
                      v={v}
                      active={active}
                      label="Сделать активной"
                    />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {compare && (
        <div className="stack">
          <div className="small">
            Разница: активная <code>{active.label}</code> → <code>{compare.label}</code>
          </div>
          <Diff before={active.text} after={compare.text} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Тест

function TestTab({ s, draft }: { s: AgentSettings; draft: string | null }) {
  const hasDraft = draft !== null && draft !== s.prompts.active.text;
  const [useDraft, setUseDraft] = useState(hasDraft);
  const run = useMutation({
    mutationFn: (promptText: string | null) =>
      api.post<AgentTestResult>(`/api/agents/${s.agent.id}/test`, { promptText }),
  });
  const result: AgentTestResult | null =
    run.data ??
    (run.error instanceof ApiError ? (run.error.body as unknown as AgentTestResult) : null);
  return (
    <div className="stack">
      <p className="small">
        Тестовый запуск на примере брифа про осеннее меню кофейни. Модель — <b>mock</b>: без
        обращения к API, <b>$0</b>. Работает и на паузе; на доске задач не появляется.
      </p>
      {hasDraft && (
        <label className="row small">
          <input
            type="checkbox"
            checked={useDraft}
            onChange={(e) => setUseDraft(e.target.checked)}
            style={{ width: 'auto' }}
          />
          С несохранённым черновиком из вкладки «Промпт»
        </label>
      )}
      <div className="row">
        <Button
          variant="primary"
          busy={run.isPending}
          onClick={() => run.mutate(hasDraft && useDraft ? draft : null)}
        >
          Запустить тест
        </Button>
      </div>
      {result && (
        <div className="stack">
          <div className={result.ok ? 'success-box' : 'error-box'}>{result.message}</div>
          <div className="small muted">
            Промпт <code>{result.promptVersion ?? '—'}</code> · модель в настройках{' '}
            <code>{result.model ?? '—'}</code> (в тесте — mock) ·{' '}
            {(result.latencyMs / 1000).toFixed(1)} с
          </div>
          {result.output != null && (
            <details open>
              <summary>Результат агента</summary>
              <pre>{JSON.stringify(result.output, null, 2)}</pre>
            </details>
          )}
          {result.input != null && (
            <details>
              <summary>Входные данные</summary>
              <pre>{JSON.stringify(result.input, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
