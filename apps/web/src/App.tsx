import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, setUnauthorizedHandler, type LlmStatus, type SessionInfo } from './api';
import { PROVIDER_LABEL } from './format';
import { useApprovals, useStatus } from './queries';
import { matchRoute, usePath } from './router';
import { Button, Link, Loading } from './ui';
import { Agents } from './pages/Agents';
import { Approvals } from './pages/Approvals';
import { Login } from './pages/Login';
import { NewTask } from './pages/NewTask';
import { RunPage } from './pages/RunPage';
import { Spend } from './pages/Spend';
import { TaskPage } from './pages/TaskPage';
import { Tasks } from './pages/Tasks';

const ROLE_LABEL: Record<string, string> = {
  ceo: 'CEO',
  worker: 'Копирайтер',
  critic: 'Critic',
  classifier: 'классификатор',
};

function modelsLabel(s: LlmStatus): string {
  const names = new Set(Object.values(s.models));
  if (names.size === 1) return [...names][0]!;
  return Object.entries(s.models)
    .filter(([role]) => role !== 'classifier')
    .map(([role, m]) => `${ROLE_LABEL[role] ?? role}: ${m}`)
    .join(' · ');
}

function LlmBadge() {
  const { data } = useStatus();
  if (!data) return null;
  const title = [
    `Провайдер: ${PROVIDER_LABEL[data.provider] ?? data.provider}`,
    data.gatewayHost ? `Шлюз: ${data.gatewayHost}` : null,
    ...Object.entries(data.models).map(([r, m]) => `${ROLE_LABEL[r] ?? r}: ${m}`),
    `Лимит запросов: ${data.rateLimit.perMinute}/мин, ${data.rateLimit.perHour}/час`,
    data.unpricedModels.length ? `Нет цены: ${data.unpricedModels.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`llm-badge provider-${data.provider}`} title={title}>
      <b>{PROVIDER_LABEL[data.provider] ?? data.provider}</b>
      <span>{modelsLabel(data)}</span>
      {data.unpricedModels.length > 0 && <span className="danger">⚠️ нет цены</span>}
    </div>
  );
}

function Header({ path, onLogout }: { path: string; onLogout: () => void }) {
  const { data: approvals } = useApprovals();
  const nav = [
    { to: '/', label: 'Агенты', active: path === '/' },
    {
      to: '/tasks',
      label: 'Задачи',
      active: path.startsWith('/tasks') || path.startsWith('/runs'),
    },
    {
      to: '/approvals',
      label: 'Согласование',
      active: path === '/approvals',
      badge: approvals?.count,
    },
    { to: '/spend', label: 'Расходы', active: path === '/spend' },
  ];
  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          Content<span>Agents</span>
        </Link>
        <nav>
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={n.active ? 'active' : ''}>
              {n.label}
              {n.badge ? <span className="badge">{n.badge}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="header-right">
          <LlmBadge />
          <Link to="/tasks/new" className="btn btn-primary">
            + Задача
          </Link>
          <Button variant="danger" disabled title="Будет в шаге 2: глобальная пауза всех агентов">
            Остановить всё
          </Button>
          <Button variant="ghost" onClick={onLogout}>
            Выйти
          </Button>
        </div>
      </div>
    </header>
  );
}

function Page({ path }: { path: string }) {
  if (path === '/') return <Agents />;
  if (path === '/tasks') return <Tasks />;
  if (path === '/tasks/new') return <NewTask />;
  if (path === '/approvals') return <Approvals />;
  if (path === '/spend') return <Spend />;
  const task = matchRoute('/tasks/:id', path);
  if (task) return <TaskPage key={task.id} id={task.id!} />;
  const run = matchRoute('/runs/:id', path);
  if (run) return <RunPage key={run.id} id={run.id!} />;
  return (
    <div className="empty">
      Страница не найдена. <Link to="/">На главную</Link>
    </div>
  );
}

export function App() {
  const qc = useQueryClient();
  const path = usePath();
  // undefined = still checking the cookie, null = logged out
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setSession(null);
      qc.clear();
    });
    api.get<SessionInfo>('/api/session').then(
      (s) => {
        setCsrfToken(s.csrfToken);
        setSession(s);
      },
      () => setSession(null),
    );
  }, [qc]);

  if (session === undefined) return <Loading />;
  if (session === null) {
    return (
      <Login
        onLogin={(s) => {
          setCsrfToken(s.csrfToken);
          setSession(s);
        }}
      />
    );
  }

  const logout = () => {
    void api.post('/api/logout').finally(() => {
      setCsrfToken(null);
      setSession(null);
      qc.clear();
    });
  };

  return (
    <>
      <Header path={path} onLogout={logout} />
      <main className="main">
        <Page path={path} />
      </main>
    </>
  );
}
