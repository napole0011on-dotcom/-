import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api';
import { Button, Link, Modal, useToast } from '../ui';

/**
 * «Удалить агента»: asks first (an active agent stops getting tasks; the last planner leaves
 * new tasks waiting). The server refuses while the agent is in the plan of an unfinished task
 * and names it; prompt versions and run history stay.
 */
export function DeleteAgentDialog({
  agent,
  lastPlanner,
  onClose,
  onDeleted,
}: {
  agent: { id: string; name: string; status: string };
  lastPlanner: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [refused, setRefused] = useState<{ message: string; taskId?: string } | null>(null);
  const del = useMutation({
    mutationFn: () => api.post(`/api/agents/${agent.id}/delete`),
    onSuccess: (r) => {
      toast(r.message, true);
      onDeleted();
    },
    onError: (err) => {
      const body = err instanceof ApiError ? err.body : {};
      setRefused({
        message: err instanceof Error ? err.message : 'Не удалось удалить',
        ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
      });
    },
    onSettled: () => qc.invalidateQueries(),
  });
  return (
    <Modal title={`Удалить агента «${agent.name}»?`} onClose={onClose}>
      <div className="modal-text stack">
        {agent.status === 'active' && <p>Агент включён, он перестанет получать задачи.</p>}
        {lastPlanner && (
          <p className="warn">
            Это последний планировщик: новые задачи будут ждать в «приёме», пока вы не создадите
            нового.
          </p>
        )}
        <p className="small muted">
          Связи и место на доске удалятся. Версии промпта и история запусков останутся. Агента с тем
          же названием потом можно создать заново — у него будет новый id.
        </p>
        {refused && (
          <div className="error-box" role="alert">
            {refused.message}{' '}
            {refused.taskId && <Link to={`/tasks/${refused.taskId}`}>Открыть задачу</Link>}
          </div>
        )}
      </div>
      <div className="row end">
        <Button onClick={onClose}>Нет</Button>
        <Button variant="danger" busy={del.isPending} onClick={() => del.mutate()}>
          Да, удалить
        </Button>
      </div>
    </Modal>
  );
}
