import { Empty, Link } from '../ui';

/** Agent constructor (filled in by the next step of this stage). */
export function NewAgent() {
  return (
    <>
      <div className="crumbs small">
        <Link to="/">Рабочий стол</Link> /
      </div>
      <h1>Новый агент</h1>
      <div className="card">
        <Empty icon="plus">Конструктор агентов появится на следующем шаге.</Empty>
      </div>
    </>
  );
}
