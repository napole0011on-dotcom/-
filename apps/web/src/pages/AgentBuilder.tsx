import { useState, type CSSProperties } from 'react';
import { api, type AgentSettings, type FieldSpec, type FieldType, type SubFieldSpec } from '../api';
import { ModelTab, PromptTab, TestTab } from '../components/AgentDrawer';
import { agentVar, dateTime } from '../format';
import { Icon } from '../icons';
import { useAgentSettings } from '../queries';
import { navigate } from '../router';
import { Button, ConfirmButton, ErrorBox, Link, Loading, Pill, useAction } from '../ui';
import { MODEL_ROLES, MODEL_ROLE_TEXT } from './NewAgent';

const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'строка' },
  { id: 'long_text', label: 'текст' },
  { id: 'list', label: 'список строк' },
  { id: 'items', label: 'список объектов' },
  { id: 'number', label: 'число' },
  { id: 'boolean', label: 'да/нет' },
];
const SUB_TYPES = FIELD_TYPES.filter((t) => !['list', 'items'].includes(t.id)) as {
  id: SubFieldSpec['type'];
  label: string;
}[];

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}; // prettier-ignore

/** Field key from its label ("Ключевые слова" -> "klyuchevye_slova"). Same rule as the server. */
export function keyFromLabel(label: string): string {
  const s = [...label.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : s ? `f_${s}`.slice(0, 40) : '';
}

const STATUS_PILL = {
  active: { tone: 'success' as const, label: 'включён' },
  draft: { tone: 'accent' as const, label: 'черновик' },
  planned: { tone: 'muted' as const, label: 'запланирован' },
};

/** Constructor: fields of the result, Critic criteria, prompt, model, test, switch on. */
export function AgentBuilder({ id }: { id: string }) {
  const { data, error, isLoading } = useAgentSettings(id);
  const [draft, setDraft] = useState<string | null>(null);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error ?? new Error('Агент не найден')} />;
  if (data.agent.kind !== 'constructor' || !data.constructor) {
    return (
      <div className="empty">
        {data.agent.name} описан в коде: его промпт и модель меняются в «Настроить» на рабочем
        столе. <Link to="/">На рабочий стол</Link>
      </div>
    );
  }
  const s = data;
  const c = data.constructor;
  const st = STATUS_PILL[s.agent.status];
  return (
    <div className="stack" style={{ '--agent': agentVar(s.agent.color) } as CSSProperties}>
      <div className="crumbs small">
        <Link to="/">Рабочий стол</Link> / конструктор
      </div>
      <div className="page-head">
        <div className="row">
          <div className="avatar" aria-hidden>
            {s.agent.icon}
          </div>
          <div className="title-block">
            <h1>{s.agent.name}</h1>
            <small>{s.agent.role}</small>
          </div>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <Link to={`/agents/${id}/blocks`} className="btn">
          Собрать из блоков
        </Link>
      </div>
      <Readiness s={s} />
      <section className="card stack">
        <h2>Основное</h2>
        <Basics key={`${s.agent.name}|${s.agent.role}|${s.model.role}`} s={s} />
      </section>
      <section className="card stack">
        <h2>Результат</h2>
        <FieldsEditor key={JSON.stringify([c.fields, c.criteria])} s={s} />
      </section>
      <section className="card stack">
        <h2>Промпт</h2>
        <PromptTab s={s} draft={draft} setDraft={setDraft} />
      </section>
      <section className="card stack">
        <h2>Тест</h2>
        <TestTab s={s} draft={draft} />
      </section>
      <section className="card stack">
        <h2>Модель</h2>
        <ModelTab key={s.model.name} s={s} />
      </section>
    </div>
  );
}

function Readiness({ s }: { s: AgentSettings }) {
  const c = s.constructor!;
  const activate = useAction(() => api.post(`/api/agents/${s.agent.id}/activate`));
  const deactivate = useAction(() => api.post(`/api/agents/${s.agent.id}/deactivate`));
  const remove = useAction(
    () => api.post(`/api/agents/${s.agent.id}/delete`),
    (r) => r.ok && navigate('/'),
  );
  const active = s.agent.status === 'active';
  return (
    <section className="card stack">
      <h2>Готовность</h2>
      {active ? (
        <div className="success-box">
          Агент включён: связи с ним на доске работают для новых задач. Изменение полей вернёт его в
          черновик до нового теста.
        </div>
      ) : c.activationProblems.length ? (
        <ul className="stack small">
          {c.activationProblems.map((p) => (
            <li key={p}>
              <Icon name="alert" /> {p}
            </li>
          ))}
        </ul>
      ) : (
        <div className="success-box">Тест текущей версии прошёл — агента можно включать.</div>
      )}
      {c.lastTest && (
        <div className="muted small">
          Последний тест: {c.lastTest.ok ? 'прошёл' : 'не прошёл'}, {dateTime(c.lastTest.at)} ·
          промпт <code>{c.lastTest.promptVersion}</code>
        </div>
      )}
      <div className="row wrap">
        {active ? (
          <ConfirmButton
            label="Сделать черновиком"
            title={`Выключить ${s.agent.name}?`}
            text="В новых задачах его шага не будет. Начатые задачи с этим шагом подождут, пока вы снова его включите."
            confirmLabel="Да, выключить"
            busy={deactivate.isPending}
            onConfirm={() => deactivate.mutate(undefined)}
          />
        ) : (
          <Button
            variant="primary"
            disabled={c.activationProblems.length > 0}
            busy={activate.isPending}
            onClick={() => activate.mutate(undefined)}
          >
            <Icon name="play" /> Включить агента
          </Button>
        )}
        {!active && (
          <ConfirmButton
            label={
              <>
                <Icon name="trash" /> Удалить
              </>
            }
            variant="ghost"
            title={`Удалить ${s.agent.name}?`}
            text="Агент и все его связи на доске будут удалены. Версии промпта останутся в журнале."
            confirmLabel="Да, удалить"
            danger
            busy={remove.isPending}
            onConfirm={() => remove.mutate(undefined)}
          />
        )}
      </div>
    </section>
  );
}

function Basics({ s }: { s: AgentSettings }) {
  const [name, setName] = useState(s.agent.name);
  const [role, setRole] = useState(s.agent.role);
  const [description, setDescription] = useState(s.agent.description);
  const [modelRole, setModelRole] = useState<string>(s.model.role);
  const save = useAction(() =>
    api.post(`/api/agents/${s.agent.id}/definition`, { name, role, description, modelRole }),
  );
  const dirty =
    name !== s.agent.name ||
    role !== s.agent.role ||
    description !== s.agent.description ||
    modelRole !== s.model.role;
  return (
    <>
      <label htmlFor="b-name">Название</label>
      <input id="b-name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="b-role">Роль</label>
      <input id="b-role" maxLength={120} value={role} onChange={(e) => setRole(e.target.value)} />
      <label htmlFor="b-desc">Описание</label>
      <textarea
        id="b-desc"
        rows={2}
        maxLength={600}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label htmlFor="b-model">Модель по роли</label>
      <select id="b-model" value={modelRole} onChange={(e) => setModelRole(e.target.value)}>
        {MODEL_ROLES.map((r) => (
          <option key={r} value={r}>
            {MODEL_ROLE_TEXT[r]}
          </option>
        ))}
      </select>
      <div className="row">
        <Button
          variant="primary"
          disabled={!dirty}
          busy={save.isPending}
          onClick={() => save.mutate(undefined)}
        >
          Сохранить
        </Button>
        <span className="muted small">
          ID: <code>{s.agent.id}</code> — не меняется
        </span>
      </div>
    </>
  );
}

const emptyField = (): FieldSpec => ({ key: '', label: '', type: 'text', required: true });

function FieldsEditor({ s }: { s: AgentSettings }) {
  const c = s.constructor!;
  const [fields, setFields] = useState<FieldSpec[]>(() =>
    c.fields.length ? c.fields : [emptyField()],
  );
  const [criteria, setCriteria] = useState<string[]>(c.criteria);
  const save = useAction(() =>
    api.post(`/api/agents/${s.agent.id}/definition`, {
      fields: fields.map(clean),
      criteria: criteria.map((x) => x.trim()).filter(Boolean),
    }),
  );
  const dirty =
    JSON.stringify(fields.map(clean)) !== JSON.stringify(c.fields.map(clean)) ||
    JSON.stringify(criteria.filter((x) => x.trim())) !== JSON.stringify(c.criteria);
  const set = (i: number, patch: Partial<FieldSpec>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const problem = fieldsProblem(fields);
  return (
    <>
      <p className="small muted">
        Из чего состоит ответ агента. Модель обязана вернуть ровно эти поля — это проверяет код, а
        вы видите результат строками «Поле: значение».
      </p>
      {fields.map((f, i) => (
        <div key={i} className="field-row">
          <div className="field-grid">
            <div>
              <label htmlFor={`f-label-${i}`}>Название поля</label>
              <input
                id={`f-label-${i}`}
                value={f.label}
                maxLength={80}
                placeholder="Например: Хэштеги"
                onChange={(e) => {
                  const label = e.target.value;
                  const auto = !f.key || f.key === keyFromLabel(f.label);
                  set(i, { label, ...(auto ? { key: keyFromLabel(label) } : {}) });
                }}
              />
            </div>
            <div>
              <label htmlFor={`f-key-${i}`}>Ключ</label>
              <input
                id={`f-key-${i}`}
                value={f.key}
                maxLength={40}
                spellCheck={false}
                onChange={(e) => set(i, { key: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor={`f-type-${i}`}>Тип</label>
              <select
                id={`f-type-${i}`}
                value={f.type}
                onChange={(e) => {
                  const type = e.target.value as FieldType;
                  set(i, {
                    type,
                    fields:
                      type === 'items'
                        ? (f.fields ?? [{ key: 'name', label: 'Название', type: 'text' }])
                        : undefined,
                  });
                }}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            {(f.type === 'list' || f.type === 'items') && (
              <div>
                <label htmlFor={`f-min-${i}`}>Минимум</label>
                <input
                  id={`f-min-${i}`}
                  type="number"
                  min={0}
                  max={20}
                  value={f.minItems ?? ''}
                  onChange={(e) =>
                    set(i, {
                      minItems: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                />
              </div>
            )}
          </div>
          <label htmlFor={`f-hint-${i}`}>Подсказка модели (необязательно)</label>
          <input
            id={`f-hint-${i}`}
            value={f.hint ?? ''}
            maxLength={300}
            placeholder="Например: 5–10 штук, на русском, без #love"
            onChange={(e) => set(i, { hint: e.target.value })}
          />
          {f.type === 'items' && (
            <SubFields value={f.fields ?? []} onChange={(sub) => set(i, { fields: sub })} />
          )}
          <div className="row between wrap">
            <label className="row small">
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={f.required !== false}
                onChange={(e) => set(i, { required: e.target.checked })}
              />
              Обязательное
            </label>
            <Button
              variant="ghost"
              className="btn-sm"
              disabled={fields.length === 1}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
            >
              <Icon name="trash" /> Убрать поле
            </Button>
          </div>
        </div>
      ))}
      <div className="row">
        <Button
          className="btn-sm"
          disabled={fields.length >= 20}
          onClick={() => setFields((fs) => [...fs, emptyField()])}
        >
          <Icon name="plus" /> Поле
        </Button>
      </div>

      <h3>Что проверяет Critic</h3>
      <p className="small muted">
        Работает, если на доске есть связь «{s.agent.name} → Critic». Без критериев Critic проверяет
        соответствие брифу и отсутствие выдуманных фактов.
      </p>
      {criteria.map((x, i) => (
        <div key={i} className="row">
          <input
            aria-label={`Критерий ${i + 1}`}
            value={x}
            maxLength={300}
            onChange={(e) =>
              setCriteria((cs) => cs.map((c2, j) => (j === i ? e.target.value : c2)))
            }
          />
          <Button
            variant="ghost"
            className="btn-icon"
            aria-label="Убрать критерий"
            onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <div className="row">
        <Button
          className="btn-sm"
          disabled={criteria.length >= 15}
          onClick={() => setCriteria((cs) => [...cs, ''])}
        >
          <Icon name="plus" /> Критерий
        </Button>
      </div>
      {problem && dirty && <div className="error-box">{problem}</div>}
      {s.agent.status === 'active' && dirty && (
        <div className="warn small">
          Агент включён: после сохранения он станет черновиком, пока не пройдёт тест заново.
        </div>
      )}
      <div className="row">
        <Button
          variant="primary"
          disabled={!dirty || !!problem}
          busy={save.isPending}
          onClick={() => save.mutate(undefined)}
        >
          Сохранить поля
        </Button>
      </div>
    </>
  );
}

function SubFields({
  value,
  onChange,
}: {
  value: SubFieldSpec[];
  onChange: (v: SubFieldSpec[]) => void;
}) {
  const set = (i: number, patch: Partial<SubFieldSpec>) =>
    onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="stack sub-fields">
      <div className="small muted">Поля каждого объекта</div>
      {value.map((f, i) => (
        <div key={i} className="row wrap">
          <input
            aria-label="Название"
            value={f.label}
            placeholder="Название"
            maxLength={80}
            onChange={(e) => {
              const label = e.target.value;
              const auto = !f.key || f.key === keyFromLabel(f.label);
              set(i, { label, ...(auto ? { key: keyFromLabel(label) } : {}) });
            }}
          />
          <input
            aria-label="Ключ"
            value={f.key}
            placeholder="ключ"
            maxLength={40}
            spellCheck={false}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <select
            aria-label="Тип"
            value={f.type}
            onChange={(e) => set(i, { type: e.target.value as SubFieldSpec['type'] })}
          >
            {SUB_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            className="btn-icon"
            aria-label="Убрать"
            disabled={value.length === 1}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          className="btn-sm"
          disabled={value.length >= 10}
          onClick={() => onChange([...value, { key: '', label: '', type: 'text' }])}
        >
          <Icon name="plus" /> Поле объекта
        </Button>
      </div>
    </div>
  );
}

const clean = (f: FieldSpec): FieldSpec => ({
  key: f.key.trim(),
  label: f.label.trim(),
  type: f.type,
  required: f.required !== false,
  hint: (f.hint ?? '').trim(),
  ...(f.minItems !== undefined && (f.type === 'list' || f.type === 'items')
    ? { minItems: f.minItems }
    : {}),
  ...(f.type === 'items'
    ? {
        fields: (f.fields ?? []).map((x) => ({
          key: x.key.trim(),
          label: x.label.trim(),
          type: x.type,
          hint: (x.hint ?? '').trim(),
        })),
      }
    : {}),
});

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Quick checks before saving (the server validates again). */
function fieldsProblem(fields: FieldSpec[]): string | null {
  const keys = new Set<string>();
  for (const f of fields) {
    if (!f.label.trim()) return 'У каждого поля нужно название';
    if (!KEY_RE.test(f.key.trim()))
      return `Ключ «${f.key}»: латиница, цифры и _, начинается с буквы`;
    if (keys.has(f.key.trim())) return `Ключ «${f.key}» повторяется`;
    keys.add(f.key.trim());
    if (f.type === 'items') {
      if (!f.fields?.length) return `У поля «${f.label}» нужны поля объекта`;
      for (const x of f.fields)
        if (!x.label.trim() || !KEY_RE.test(x.key.trim()))
          return `Поле объекта в «${f.label}»: нужны название и ключ латиницей`;
    }
  }
  return null;
}
