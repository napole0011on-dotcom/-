import { useEffect, useMemo, useRef, useState } from 'react';
import { TEAM_ROLES, TEAM_ROLE_LABEL } from '@cms/agents/graph';
import { api, type LibraryTemplate, type TeamRole } from '../api';
import { Icon } from '../icons';
import { useLibrary } from '../queries';
import { navigate } from '../router';
import { Button, ConfirmButton, ErrorBox, Loading, Modal, Pill, useAction } from '../ui';

export const TEMPLATE_DND = 'application/x-agent-template';

/**
 * «+ Агент»: a window next to the board (not modal, so library cards can be dragged onto it)
 * with three ways to get an agent: a copy of a library template, an empty agent, or an agent
 * built from blocks. Every agent is a draft until a test passes and the owner switches it on.
 */
export function Library({
  tab: initialTab = 'library',
  onClose,
  onAdded,
}: {
  tab?: AddTab;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [tab, setTab] = useState<AddTab>(initialTab);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="library-panel" role="dialog" aria-label="Новый агент">
      <div className="row between">
        <h2>Новый агент</h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Закрыть окно"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="tabs" role="tablist">
        {ADD_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'library' && <LibraryTab onAdded={onAdded} />}
      {tab === 'empty' && (
        <NewAgentForm
          key="empty"
          hint="Пустой агент: вы задаёте роль, промпт и поля результата в конструкторе."
          onCreated={(id) => navigate(`/agents/${id}/build`)}
        />
      )}
      {tab === 'blocks' && (
        <NewAgentForm
          key="blocks"
          hint="Агент из блоков: модель, промпт, инструмент, проверка — на холсте блоков."
          onCreated={(id) => navigate(`/agents/${id}/blocks`)}
        />
      )}
    </aside>
  );
}

export type AddTab = 'library' | 'empty' | 'blocks';
const ADD_TABS: { id: AddTab; label: string }[] = [
  { id: 'library', label: 'Из библиотеки' },
  { id: 'empty', label: 'Пустой агент' },
  { id: 'blocks', label: 'Из блоков' },
];

/** Name, one-line job and team role: enough for a draft; the rest is on the next page. */
export function NewAgentForm({
  hint,
  onCreated,
}: {
  hint: string;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [teamRole, setTeamRole] = useState<TeamRole>('worker');
  const create = useAction(
    () =>
      api.post('/api/agents', {
        name: name.trim(),
        role: role.trim(),
        teamRole,
        modelRole: teamRole === 'planner' ? 'ceo' : teamRole === 'reviewer' ? 'critic' : 'worker',
      }),
    (r) => r.ok && r.id && onCreated(r.id),
  );
  const ready = name.trim().length >= 2 && role.trim().length >= 3;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate(undefined);
      }}
    >
      <p className="small muted">{hint}</p>
      <label htmlFor="new-agent-name">Название</label>
      <input
        id="new-agent-name"
        autoFocus
        maxLength={40}
        value={name}
        placeholder="Например: Редактор"
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="new-agent-role">Что делает — одной строкой</label>
      <input
        id="new-agent-role"
        maxLength={120}
        value={role}
        placeholder="Например: сокращает текст до 500 знаков"
        onChange={(e) => setRole(e.target.value)}
      />
      <TeamRoleSelect id="new-agent-team-role" value={teamRole} onChange={setTeamRole} />
      <div className="row">
        <Button type="submit" variant="primary" disabled={!ready} busy={create.isPending}>
          Создать черновик
        </Button>
      </div>
    </form>
  );
}

export const TEAM_ROLE_HINT: Record<TeamRole, string> = {
  planner: 'получает бриф и составляет план; без планировщика задачи ждут в «приёме»',
  reviewer: 'проверяет результат связанных с ним агентов, до 2 доработок',
  worker: 'делает свой шаг плана',
  acceptor: 'последний шаг перед вами: получает всё, что готово',
};

export function TeamRoleSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: TeamRole;
  onChange: (r: TeamRole) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <label htmlFor={id}>Роль в команде</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as TeamRole)}
      >
        {TEAM_ROLES.map((r) => (
          <option key={r} value={r}>
            {TEAM_ROLE_LABEL[r]} — {TEAM_ROLE_HINT[r]}
          </option>
        ))}
      </select>
    </>
  );
}

function LibraryTab({ onAdded }: { onAdded: (id: string) => void }) {
  const { data, error, isLoading } = useLibrary();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [editing, setEditing] = useState<LibraryTemplate | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const add = useAction(
    (templateId: string) => api.post('/api/library/add', { templateId }),
    (r) => r.ok && r.id && onAdded(r.id),
  );
  const remove = useAction((id: string) => api.post(`/api/library/${id}/delete`, {}));
  const importFile = useAction(
    (json: unknown) => api.post('/api/library/import', { file: json }),
    () => {
      if (file.current) file.current.value = '';
    },
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.templates ?? []).filter(
      (t) =>
        (!cat || t.category === cat) &&
        (!needle ||
          [t.name, t.role, t.description, t.category].some((s) =>
            s.toLowerCase().includes(needle),
          )),
    );
  }, [data, q, cat]);

  return (
    <>
      <input
        type="search"
        aria-label="Поиск агента"
        placeholder="Поиск: слоганы, хэштеги, отзыв…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="row wrap chips" role="group" aria-label="Категории">
        <button
          type="button"
          className="chip"
          aria-pressed={cat === null}
          onClick={() => setCat(null)}
        >
          Все
        </button>
        {data?.categories.map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            aria-pressed={cat === c}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {isLoading && <Loading rows={3} />}
      <ErrorBox error={error} />
      <p className="small muted">
        Перетащите карточку на доску или нажмите «Добавить» — появится черновик.
      </p>
      <div className="library-list">
        {shown.map((t) => (
          <Card
            key={t.id}
            t={t}
            busy={add.isPending}
            onAdd={() => add.mutate(t.id)}
            onEdit={() => setEditing(t)}
            onDelete={() => remove.mutate(t.id)}
          />
        ))}
        {data && shown.length === 0 && <p className="muted small">Ничего не нашлось.</p>}
      </div>
      <div className="row wrap library-foot">
        <label className="btn">
          Импорт JSON
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void f.text().then((text) => {
                try {
                  importFile.mutate(JSON.parse(text) as unknown);
                } catch {
                  importFile.mutate({ broken: true });
                }
              });
            }}
          />
        </label>
      </div>
      {editing && <EditTemplate t={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** The owner's edit of a template: after it library:sync no longer overwrites this template. */
function EditTemplate({ t, onClose }: { t: LibraryTemplate; onClose: () => void }) {
  const [name, setName] = useState(t.name);
  const [role, setRole] = useState(t.role);
  const [description, setDescription] = useState(t.description);
  const [teamRole, setTeamRole] = useState<TeamRole>(t.teamRole);
  const [prompt, setPrompt] = useState(t.prompt ?? '');
  const save = useAction(
    () =>
      api.post(`/api/library/${t.id}/update`, {
        name: name.trim(),
        role: role.trim(),
        description: description.trim(),
        teamRole,
        ...(t.prompt !== null ? { prompt } : {}),
      }),
    (r) => r.ok && onClose(),
  );
  return (
    <Modal title={`Шаблон «${t.name}»`} onClose={onClose}>
      <div className="stack">
        <label htmlFor="tpl-name">Название</label>
        <input
          id="tpl-name"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="tpl-role">Что делает</label>
        <input
          id="tpl-role"
          maxLength={120}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <label htmlFor="tpl-desc">Описание</label>
        <textarea
          id="tpl-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TeamRoleSelect id="tpl-team-role" value={teamRole} onChange={setTeamRole} />
        {t.prompt !== null && (
          <>
            <label htmlFor="tpl-prompt">Промпт</label>
            <textarea
              id="tpl-prompt"
              className="prompt-editor"
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </>
        )}
        <p className="small muted">
          Агенты, уже добавленные из шаблона, не меняются. После правки обновления из config/library
          этот шаблон не трогают.
        </p>
        <div className="row end">
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Card({
  t,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  t: LibraryTemplate;
  busy: boolean;
  onAdd: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className="library-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TEMPLATE_DND, t.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      aria-label={`Шаблон «${t.name}»`}
    >
      <div className="row between">
        <b>{t.name}</b>
        <span className="small muted">{t.category}</span>
      </div>
      <div className="small">{t.role}</div>
      <div className="small muted clamp-2">{t.description}</div>
      <div className="row wrap">
        <Pill tone="accent">{TEAM_ROLE_LABEL[t.teamRole]}</Pill>
        <Pill tone={t.system ? 'muted' : 'accent'}>
          {t.system ? 'стартовый' : 'ваш'} · v{t.version}
        </Pill>
        {t.realNeeds && (
          <span title={`Работает на mock. Для настоящей работы: ${t.realNeeds}`}>
            <Pill tone="info">mock</Pill>
          </span>
        )}
      </div>
      <div className="row wrap">
        <Button className="btn-sm" variant="primary" busy={busy} onClick={onAdd}>
          Добавить
        </Button>
        <Button className="btn-sm" variant="ghost" onClick={onEdit}>
          Изменить
        </Button>
        <a className="btn btn-sm btn-ghost" href={`/api/library/export/${t.id}`} download>
          Экспорт
        </a>
        <ConfirmButton
          label="Удалить"
          variant="ghost"
          danger
          title={`Удалить шаблон «${t.name}»?`}
          text="Шаблон пропадёт из библиотеки. Агенты, добавленные из него, останутся."
          confirmLabel="Удалить"
          onConfirm={onDelete}
        />
      </div>
    </article>
  );
}
