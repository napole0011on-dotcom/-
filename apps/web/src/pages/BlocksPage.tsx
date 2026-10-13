import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState, type CSSProperties, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  BLOCK_KINDS,
  BLOCK_TYPES,
  validateBlockLink,
  type Block,
  type BlockType,
  type Composition,
} from '@cms/agents/blocks';
import { api, type BlocksData, type FieldSpec } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { useBlocks } from '../queries';
import { agentVar } from '../workspace/nodes';
import { Button, ErrorBox, Link, Loading, Pill, useAction, useToast } from '../ui';
import { keyFromLabel } from './AgentBuilder';
import { MODEL_ROLES, MODEL_ROLE_TEXT } from './NewAgent';

type BlockNode = Node<{ block: Block; summary: string }, 'block'>;

const DND_TYPE = 'application/x-agent-block';

/** One line under the block title: what it is set to. */
function summaryOf(b: Block, data: BlocksData): string {
  const c = b.config;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (b.type) {
    case 'role':
      return str(c.text).slice(0, 70) || 'опишите роль';
    case 'knowledge':
      return str(c.title) || `${str(c.text).length} символов`;
    case 'model':
      return str(c.model) || `из .env (${str(c.modelRole) || 'worker'})`;
    case 'tool':
      return data.tools.find((t) => t.id === c.tool)?.name ?? 'выберите инструмент';
    case 'check':
      return `критериев: ${(c.criteria as unknown[] | undefined)?.length ?? 0}`;
    case 'output':
      return `полей: ${(c.fields as unknown[] | undefined)?.length ?? 0}`;
    case 'handoff':
      return data.agents.find((a) => a.id === c.agent)?.name ?? 'выберите агента';
    case 'gate':
      return 'на согласование вам';
    default:
      return 'бриф, план, результаты до агента';
  }
}

function BlockCard({ data, selected }: NodeProps<BlockNode>) {
  const k = BLOCK_KINDS[data.block.type];
  return (
    <div className={`blk blk-${k.type}${selected ? ' selected' : ''}`} title={k.hint}>
      {k.accepts.length > 0 && <Handle type="target" position={Position.Left} />}
      <b>{k.label}</b>
      <small className="clamp-2">{data.summary}</small>
      {!['handoff', 'gate'].includes(k.type) && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
const nodeTypes = { block: BlockCard };

export function BlocksPage({ id }: { id: string }) {
  return (
    <ReactFlowProvider>
      <BlocksEditor id={id} />
    </ReactFlowProvider>
  );
}

function BlocksEditor({ id }: { id: string }) {
  const { data, error, isLoading } = useBlocks(id);
  const toast = useToast();
  const rf = useReactFlow();
  const [comp, setComp] = useState<Composition | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  // The server's composition replaces the local one only when a different version arrives
  // (first load, rollback) — never right after our own save, while the refetch is on its way.
  const [loaded, setLoaded] = useState<number | null | undefined>(undefined);
  if (data && !dirty && data.version !== loaded) {
    setComp(data.composition);
    setLoaded(data.version);
  }

  const save = useAction(
    (c: Composition) => api.post(`/api/agents/${id}/blocks`, c),
    (r) => {
      if (!r.ok) return;
      setLoaded(r.version);
      setDirty(false);
    },
  );
  const build = useAction(
    () => api.post(`/api/agents/${id}/blocks/build`),
    (r) => setProblems(r.problems ?? (r.warnings?.length ? r.warnings : [])),
  );
  const rollback = useAction(
    (version: number) => api.post(`/api/agents/${id}/blocks/rollback`, { version }),
    (r) => r.ok && setDirty(false),
  );

  const change = useCallback((fn: (c: Composition) => Composition) => {
    setComp((c) => (c ? fn(c) : c));
    setDirty(true);
  }, []);

  const nodes: BlockNode[] = useMemo(
    () =>
      comp && data
        ? comp.blocks.map((b) => ({
            id: b.id,
            type: 'block',
            position: { x: b.x, y: b.y },
            selected: b.id === sel,
            data: { block: b, summary: summaryOf(b, data) },
          }))
        : [],
    [comp, data, sel],
  );
  const edges: Edge[] = useMemo(
    () =>
      comp?.links.map((l) => ({
        id: `${l.from}>${l.to}`,
        source: l.from,
        target: l.to,
        style: { stroke: 'var(--border-strong)', strokeWidth: 1.6 },
      })) ?? [],
    [comp],
  );

  const addBlock = (type: BlockType, at?: { x: number; y: number }) => {
    if (!comp) return;
    const k = BLOCK_KINDS[type];
    if (k.max !== null && comp.blocks.filter((b) => b.type === type).length >= k.max) {
      toast(`Блоков «${k.label}» не больше ${k.max}`, false);
      return;
    }
    let n = 1;
    while (comp.blocks.some((b) => b.id === `${type}${n}`)) n++;
    const pos = at ?? { x: 40 + comp.blocks.length * 30, y: 260 };
    change((c) => ({
      ...c,
      blocks: [...c.blocks, { id: `${type}${n}`, type, x: pos.x, y: pos.y, config: {} }],
    }));
    setSel(`${type}${n}`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData(DND_TYPE) as BlockType;
    if (!BLOCK_TYPES.includes(type)) return;
    addBlock(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  if (isLoading) return <Loading />;
  if (!data || !comp) return <ErrorBox error={error ?? new Error('Агент не найден')} />;
  const block = comp.blocks.find((b) => b.id === sel) ?? null;
  const why = (c: Connection | Edge) => validateBlockLink(comp, c.source, c.target);
  const shownProblems = problems ?? (dirty ? null : data.problems);

  return (
    <div className="stack" style={{ '--agent': agentVar(data.agent.color) } as CSSProperties}>
      <nav className="crumbs small" aria-label="Путь">
        <Link to="/">Рабочий стол</Link> / <Link to={`/agents/${id}/build`}>{data.agent.name}</Link>{' '}
        / Блоки
      </nav>
      <div className="page-head">
        <div className="row">
          <h1>{data.agent.name}: блоки</h1>
          <Pill tone={data.agent.status === 'active' ? 'success' : 'muted'}>
            {data.agent.status === 'active' ? 'включён' : 'черновик'}
          </Pill>
        </div>
        <div className="row wrap">
          <Button disabled={!dirty} busy={save.isPending} onClick={() => save.mutate(comp)}>
            Сохранить{dirty ? ' *' : ''}
          </Button>
          <Button
            variant="primary"
            disabled={dirty || data.version === null}
            title={dirty ? 'Сначала сохраните' : undefined}
            busy={build.isPending}
            onClick={() => build.mutate(undefined)}
          >
            Собрать в агента
          </Button>
          <Link to={`/agents/${id}/build`} className="btn btn-ghost">
            Тест и включение →
          </Link>
        </div>
      </div>
      {shownProblems && shownProblems.length > 0 && (
        <div className="card warn-card">
          <b>Что поправить:</b>
          <ul className="small">
            {shownProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="blocks-layout">
        <aside className="card blocks-palette" aria-label="Блоки">
          <h2>Блоки</h2>
          <p className="small muted">Перетащите на холст или нажмите «+».</p>
          {BLOCK_TYPES.map((t) => (
            <div
              key={t}
              className={`palette-item blk-${t}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_TYPE, t);
                e.dataTransfer.effectAllowed = 'move';
              }}
              title={BLOCK_KINDS[t].hint}
            >
              <span>{BLOCK_KINDS[t].label}</span>
              <button
                type="button"
                className="linklike"
                aria-label={`Добавить блок «${BLOCK_KINDS[t].label}»`}
                onClick={() => addBlock(t)}
              >
                <Icon name="plus" />
              </button>
            </div>
          ))}
        </aside>
        <div className="blocks-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow<BlockNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.4}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            isValidConnection={(c) => why(c) === null}
            onConnect={(c) =>
              change((x) => ({ ...x, links: [...x.links, { from: c.source, to: c.target }] }))
            }
            onConnectEnd={(event, st) => {
              if (st.isValid || !st.fromNode) return;
              const p = 'changedTouches' in event ? event.changedTouches[0] : event;
              const el = p ? document.elementFromPoint(p.clientX, p.clientY) : null;
              const target =
                st.toNode?.id ?? el?.closest('.react-flow__node')?.getAttribute('data-id');
              if (!target || target === st.fromNode.id) return;
              const reason = validateBlockLink(comp, st.fromNode.id, target);
              if (reason) toast(reason, false);
              else
                change((x) => ({
                  ...x,
                  links: [...x.links, { from: st.fromNode.id, to: target }],
                }));
            }}
            onNodeClick={(_, n) => setSel(n.id)}
            onPaneClick={() => setSel(null)}
            onNodeDragStop={(_, n) =>
              change((x) => ({
                ...x,
                blocks: x.blocks.map((b) =>
                  b.id === n.id
                    ? { ...b, x: Math.round(n.position.x), y: Math.round(n.position.y) }
                    : b,
                ),
              }))
            }
            onNodesDelete={(del) =>
              change((x) => {
                const ids = new Set(del.map((d) => d.id));
                return {
                  blocks: x.blocks.filter((b) => !ids.has(b.id)),
                  links: x.links.filter((l) => !ids.has(l.from) && !ids.has(l.to)),
                };
              })
            }
            onEdgesDelete={(del) =>
              change((x) => ({
                ...x,
                links: x.links.filter((l) => !del.some((d) => d.id === `${l.from}>${l.to}`)),
              }))
            }
            deleteKeyCode={['Delete', 'Backspace']}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          </ReactFlow>
        </div>
        <aside className="card stack blocks-props">
          {block ? (
            <BlockProps
              key={block.id}
              block={block}
              data={data}
              onChange={(config) =>
                change((x) => ({
                  ...x,
                  blocks: x.blocks.map((b) => (b.id === block.id ? { ...b, config } : b)),
                }))
              }
            />
          ) : (
            <p className="small muted">
              Выберите блок, чтобы настроить его. Соединяйте точки справа и слева: недопустимое
              соединение подсвечивается и объясняется.
            </p>
          )}
          <Versions data={data} busy={rollback.isPending} onRollback={(v) => rollback.mutate(v)} />
        </aside>
      </div>
    </div>
  );
}

function BlockProps({
  block,
  data,
  onChange,
}: {
  block: Block;
  data: BlocksData;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const k = BLOCK_KINDS[block.type];
  const c = block.config;
  const set = (patch: Record<string, unknown>) => onChange({ ...c, ...patch });
  const str = (key: string) => (typeof c[key] === 'string' ? c[key] : '');
  return (
    <div className="stack">
      <h2>{k.label}</h2>
      <p className="small muted">{k.hint}</p>
      {block.type === 'role' && (
        <textarea
          rows={8}
          aria-label="Роль"
          value={str('text')}
          placeholder="Ты — … Твоя задача — …"
          onChange={(e) => set({ text: e.target.value })}
        />
      )}
      {block.type === 'knowledge' && (
        <>
          <input
            aria-label="Заголовок"
            placeholder="Заголовок"
            value={str('title')}
            onChange={(e) => set({ title: e.target.value })}
          />
          <textarea
            rows={8}
            aria-label="Знания"
            value={str('text')}
            onChange={(e) => set({ text: e.target.value })}
          />
        </>
      )}
      {block.type === 'model' && (
        <>
          <label className="small" htmlFor="blk-role">
            Роль модели (.env)
          </label>
          <select
            id="blk-role"
            value={str('modelRole') || 'worker'}
            onChange={(e) => set({ modelRole: e.target.value })}
          >
            {MODEL_ROLES.map((r) => (
              <option key={r} value={r}>
                {MODEL_ROLE_TEXT[r]}
              </option>
            ))}
          </select>
          <label className="small" htmlFor="blk-model">
            Модель
          </label>
          <select
            id="blk-model"
            value={str('model')}
            onChange={(e) => set({ model: e.target.value || null })}
          >
            <option value="">из .env по роли</option>
            {data.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </>
      )}
      {block.type === 'tool' && (
        <select
          aria-label="Инструмент"
          value={str('tool')}
          onChange={(e) => set({ tool: e.target.value })}
        >
          <option value="">выберите…</option>
          {data.tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {block.type === 'handoff' && (
        <select
          aria-label="Кому передать"
          value={str('agent')}
          onChange={(e) => set({ agent: e.target.value })}
        >
          <option value="">выберите агента…</option>
          {data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.status !== 'active' ? ' (не активен)' : ''}
            </option>
          ))}
        </select>
      )}
      {block.type === 'check' && (
        <textarea
          rows={6}
          aria-label="Критерии"
          placeholder="Один критерий на строку"
          value={((c.criteria as string[] | undefined) ?? []).join('\n')}
          onChange={(e) => set({ criteria: e.target.value.split('\n') })}
        />
      )}
      {block.type === 'output' && (
        <OutputFields
          fields={(c.fields as FieldSpec[] | undefined) ?? []}
          onChange={(fields) => set({ fields })}
        />
      )}
    </div>
  );
}

const FIELD_TYPES: [FieldSpec['type'], string][] = [
  ['text', 'строка'],
  ['long_text', 'текст'],
  ['list', 'список строк'],
  ['number', 'число'],
  ['boolean', 'да/нет'],
];

function OutputFields({
  fields,
  onChange,
}: {
  fields: FieldSpec[];
  onChange: (f: FieldSpec[]) => void;
}) {
  const put = (i: number, patch: Partial<FieldSpec>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="stack">
      {fields.map((f, i) => (
        <div key={i} className="row wrap out-field">
          <input
            aria-label={`Поле ${i + 1}`}
            placeholder="Название поля"
            value={f.label}
            onChange={(e) =>
              put(i, {
                label: e.target.value,
                key: keyFromLabel(e.target.value) || `field_${i + 1}`,
              })
            }
          />
          <select
            aria-label={`Тип поля ${i + 1}`}
            value={f.type}
            onChange={(e) => put(i, { type: e.target.value as FieldSpec['type'] })}
          >
            {FIELD_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="linklike danger"
            aria-label={`Убрать поле ${i + 1}`}
            onClick={() => onChange(fields.filter((_, j) => j !== i))}
          >
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <Button
        className="btn-sm"
        onClick={() =>
          onChange([
            ...fields,
            {
              key: `field_${fields.length + 1}`,
              label: '',
              type: 'text',
              required: true,
              hint: '',
            },
          ])
        }
      >
        <Icon name="plus" /> Поле
      </Button>
      <p className="small muted">Вложенные поля (список объектов) — в конструкторе агента.</p>
    </div>
  );
}

function Versions({
  data,
  busy,
  onRollback,
}: {
  data: BlocksData;
  busy: boolean;
  onRollback: (v: number) => void;
}) {
  if (data.versions.length === 0)
    return <p className="small muted">Версий пока нет: «Сохранить» создаст первую.</p>;
  return (
    <section className="stack">
      <h2>Версии</h2>
      <ol className="versions small">
        {data.versions.map((v) => (
          <li key={v.version} className="row between">
            <span>
              v{v.version} · {v.note}
              {v.built ? ' · собрана' : ''}
              <br />
              <span className="muted">{dateTime(v.createdAt)}</span>
            </span>
            {v.version !== data.version && (
              <Button className="btn-sm" busy={busy} onClick={() => onRollback(v.version)}>
                Вернуть
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
