import { navigate } from '../router';
import { Link } from '../ui';
import { NewAgentForm } from '../workspace/Library';

export const MODEL_ROLES = ['worker', 'critic', 'ceo'] as const;
export const MODEL_ROLE_TEXT: Record<string, string> = {
  worker: 'Обычная (LLM_MODEL_WORKER)',
  critic: 'Для проверки (LLM_MODEL_CRITIC)',
  ceo: 'Сильная, для планирования (LLM_MODEL_CEO)',
};

/** «Пустой агент» as a page (the same form as in the «+ Агент» window). */
export function NewAgent() {
  return (
    <>
      <div className="crumbs small">
        <Link to="/">Рабочий стол</Link> /
      </div>
      <div className="page-head">
        <h1>Новый агент</h1>
      </div>
      <div className="card stack narrow">
        <NewAgentForm
          hint="Агент появится на доске черновиком; работать начнёт после успешного теста и включения."
          onCreated={(id) => navigate(`/agents/${id}/build`)}
        />
      </div>
    </>
  );
}
