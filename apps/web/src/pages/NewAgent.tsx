import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Button, Link, useAction } from '../ui';

export const MODEL_ROLES = ['worker', 'critic', 'ceo'] as const;
export const MODEL_ROLE_TEXT: Record<string, string> = {
  worker: 'Исполнитель — как у Копирайтера (LLM_MODEL_WORKER)',
  critic: 'Проверяющий — как у Critic (LLM_MODEL_CRITIC)',
  ceo: 'Сильная — как у CEO (LLM_MODEL_CEO)',
};

/** Step 1 of the constructor: who the agent is. Fields, prompt and test come on the next page. */
export function NewAgent() {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [modelRole, setModelRole] = useState<string>('worker');
  const [prompt, setPrompt] = useState('');
  const create = useAction(
    () =>
      api.post('/api/agents', {
        name: name.trim(),
        role: role.trim(),
        description: description.trim(),
        modelRole,
        prompt: prompt.trim() || null,
      }),
    (r) => r.ok && r.id && navigate(`/agents/${r.id}/build`),
  );
  const ready = name.trim().length >= 2 && role.trim().length >= 3;
  return (
    <>
      <div className="crumbs small">
        <Link to="/">Рабочий стол</Link> /
      </div>
      <div className="page-head">
        <h1>Новый агент</h1>
      </div>
      <div className="card stack narrow">
        <p className="small muted">
          Агент из конструктора — это вызов модели с вашим промптом и результатом из простых полей.
          Он появится на доске черновиком; работать начнёт после успешного теста и включения.
        </p>
        <label htmlFor="agent-name">Название</label>
        <input
          id="agent-name"
          autoFocus
          maxLength={40}
          value={name}
          placeholder="Например: SEO-менеджер"
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="agent-role">Роль — одной строкой</label>
        <input
          id="agent-role"
          maxLength={120}
          value={role}
          placeholder="Например: подбирает ключевые слова и хэштеги"
          onChange={(e) => setRole(e.target.value)}
        />
        <label htmlFor="agent-desc">Описание (необязательно)</label>
        <textarea
          id="agent-desc"
          rows={3}
          maxLength={600}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label htmlFor="agent-model">Модель</label>
        <select id="agent-model" value={modelRole} onChange={(e) => setModelRole(e.target.value)}>
          {MODEL_ROLES.map((r) => (
            <option key={r} value={r}>
              {MODEL_ROLE_TEXT[r]}
            </option>
          ))}
        </select>
        <label htmlFor="agent-prompt">Системный промпт (можно позже)</label>
        <textarea
          id="agent-prompt"
          className="prompt-editor"
          rows={8}
          value={prompt}
          placeholder="Кто ты, что делаешь, чего не делаешь никогда"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row">
          <Button
            variant="primary"
            disabled={!ready}
            busy={create.isPending}
            onClick={() => create.mutate(undefined)}
          >
            Создать черновик
          </Button>
          <Link to="/" className="btn btn-ghost">
            Отмена
          </Link>
        </div>
      </div>
    </>
  );
}
