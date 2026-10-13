import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LibraryTemplate } from '../api';
import { Icon } from '../icons';
import { useLibrary } from '../queries';
import { navigate } from '../router';
import { Button, ErrorBox, Loading, Pill, useAction } from '../ui';

export const TEMPLATE_DND = 'application/x-agent-template';

/**
 * «+ Агент»: the agent library next to the board (not modal, so cards can be dragged onto it).
 * «Добавить» or a drop on the board makes a draft copy; tool templates that need a paid
 * service are shown but cannot be added until the owner connects it.
 */
export function Library({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const { data, error, isLoading } = useLibrary();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const add = useAction(
    (templateId: string) => api.post('/api/library/add', { templateId }),
    (r) => r.ok && r.id && onAdded(r.id),
  );
  const importFile = useAction(
    (json: unknown) => api.post('/api/library/import', { file: json }),
    () => {
      if (file.current) file.current.value = '';
    },
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <aside className="library-panel" role="dialog" aria-label="Библиотека агентов">
      <div className="row between">
        <h2>Библиотека агентов</h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Закрыть библиотеку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
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
          <Card key={t.id} t={t} busy={add.isPending} onAdd={() => add.mutate(t.id)} />
        ))}
        {data && shown.length === 0 && <p className="muted small">Ничего не нашлось.</p>}
      </div>
      <div className="row wrap library-foot">
        <Button onClick={() => navigate('/agents/new')}>
          <Icon name="plus" /> Пустой агент
        </Button>
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
    </aside>
  );
}

function Card({ t, busy, onAdd }: { t: LibraryTemplate; busy: boolean; onAdd: () => void }) {
  const blocked = !!t.requiresKey;
  return (
    <article
      className={`library-card${blocked ? ' blocked' : ''}`}
      draggable={!blocked}
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
        <Pill tone={t.system ? 'muted' : 'accent'}>
          {t.system ? 'системный' : 'ваш'} · v{t.version}
        </Pill>
        {blocked && (
          <span title={t.requiresKey ?? ''}>
            <Pill tone="danger">нужен ключ</Pill>
          </span>
        )}
      </div>
      <div className="row">
        <Button className="btn-sm" variant="primary" disabled={blocked} busy={busy} onClick={onAdd}>
          Добавить
        </Button>
        <a className="btn btn-sm btn-ghost" href={`/api/library/export/${t.id}`} download>
          Экспорт
        </a>
      </div>
    </article>
  );
}
