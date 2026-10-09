import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Button, useAction } from '../ui';

export function NewTask() {
  const [brief, setBrief] = useState('');
  const create = useAction(
    (b: string) => api.post('/api/tasks', { brief: b }),
    (r) => r.ok && r.taskId && navigate(`/tasks/${r.taskId}`),
  );
  const tooShort = brief.trim().length < 10;
  return (
    <>
      <h1>Новая задача</h1>
      <div className="card stack narrow">
        <label htmlFor="brief">Бриф</label>
        <textarea
          id="brief"
          rows={8}
          autoFocus
          maxLength={8000}
          value={brief}
          placeholder="Например: подготовь пост для Instagram и пост для Telegram про осеннее меню кофейни"
          onChange={(e) => setBrief(e.target.value)}
        />
        <div className="muted small">
          CEO составит план с оценкой стоимости — он придёт на согласование сюда и в Telegram.
        </div>
        <div className="row">
          <Button
            variant="primary"
            disabled={tooShort}
            busy={create.isPending}
            onClick={() => create.mutate(brief.trim())}
          >
            Создать
          </Button>
        </div>
      </div>
    </>
  );
}
