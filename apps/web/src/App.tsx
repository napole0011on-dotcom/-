import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, setUnauthorizedHandler, type LlmStatus, type SessionInfo } from './api';
import { PROVIDER_LABEL, ROLE_LABEL, actorLabel, dateTime } from './format';
import { useApprovals, useStatus } from './queries';
import { matchRoute, usePath } from './router';
import { Icon } from './icons';
import { useTheme } from './theme/theme';
import { Button, ConfirmButton, Link, Loading, useAction } from './ui';
import { Agents } from './pages/Agents';
import { Approvals } from './pages/Approvals';
import { Login } from './pages/Login';
import { NewAgent } from './pages/NewAgent';
import { NewTask } from './pages/NewTask';
import { RunPage } from './pages/RunPage';
import { Spend } from './pages/Spend';
import { TaskPage } from './pages/TaskPage';
import { Tasks } from './pages/Tasks';

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
    <div className="llm-chip" title={title}>
      <b>{PROVIDER_LABEL[data.provider] ?? data.provider}</b>
      <span>{modelsLabel(data)}</span>
      {data.unpricedModels.length > 0 && <span className="danger">нет цены в прайсе</span>}
    </div>
  );
}

/** Global pause: confirm before stopping; resume is one click. */
function StopAllButton() {
  const { data } = useStatus();
  const stop = useAction(() => api.post('/api/controls/stop-all'));
  const resume = useAction(() => api.post('/api/controls/resume-all'));
  if (!data) return null;
  if (data.controls.allPaused) {
    return (
      <Button variant="primary" busy={resume.isPending} onClick={() => resume.mutate()}>
        <Icon name="play" /> Продолжить всё
      </Button>
    );
  }
  return (
    <ConfirmButton
      label={
        <>
          <Icon name="stop" /> Остановить всё
        </>
      }
      variant="danger"
      title="Остановить всех агентов?"
      text="Новые запуски всех агентов будут ждать в очереди; те, что уже идут, доработают. Задачи не теряются: после «Продолжить всё» очередь разберётся автоматически."
      confirmLabel="Да, остановить"
      danger
      busy={stop.isPending}
      onConfirm={() => stop.mutate()}
    />
  );
}

function StoppedBanner() {
  const { data } = useStatus();
  if (!data?.controls.allPaused) return null;
  return (
    <div className="banner" role="status">
      <Icon name="pause" />
      <span>
        Все агенты остановлены
        {data.controls.changedBy
          ? ` (${actorLabel(data.controls.changedBy)}, ${dateTime(data.controls.changedAt)})`
          : ''}
        . Новые запуски ждут в очереди.
      </span>
    </div>
  );
}

const THEME_LABEL = { system: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };

function ThemeButton() {
  const [choice, next] = useTheme();
  return (
    <Button
      variant="ghost"
      className="btn-icon"
      onClick={next}
      title={THEME_LABEL[choice]}
      aria-label={THEME_LABEL[choice]}
    >
      <Icon name={choice === 'dark' ? 'moon' : choice === 'light' ? 'sun' : 'monitor'} />
    </Button>
  );
}

function Header({ path, onLogout }: { path: string; onLogout: () => void }) {
  const { data: approvals } = useApprovals();
  // The mobile menu belongs to the page it was opened on: navigating closes it.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menu = menuAt === path;
  const setMenu = (open: boolean) => setMenuAt(open ? path : null);
  const nav = [
    { to: '/', label: 'Агенты', icon: 'agents' as const, active: path === '/' },
    {
      to: '/tasks',
      label: 'Задачи',
      icon: 'tasks' as const,
      active: path.startsWith('/tasks') || path.startsWith('/runs'),
    },
    {
      to: '/approvals',
      label: 'Согласование',
      icon: 'approvals' as const,
      active: path === '/approvals',
      badge: approvals?.count,
    },
    { to: '/spend', label: 'Расходы', icon: 'spend' as const, active: path === '/spend' },
  ];
  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          Content<b>Agents</b>
        </Link>
        <nav className="nav" aria-label="Разделы">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={n.active ? 'active' : ''}
              aria-current={n.active ? 'page' : undefined}
            >
              {n.label}
              {n.badge ? <span className="badge">{n.badge}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="header-right">
          <LlmBadge />
          <Link to="/tasks/new" className="btn btn-primary hide-mobile">
            <Icon name="plus" /> Задача
          </Link>
          <span className="hide-mobile">
            <StopAllButton />
          </span>
          <ThemeButton />
          <Button
            variant="ghost"
            className="hide-mobile"
            onClick={onLogout}
            title="Выйти"
            aria-label="Выйти"
          >
            <Icon name="logout" /> <span className="label-wide">Выйти</span>
          </Button>
          <Button
            variant="ghost"
            className="btn-icon menu-button"
            aria-label="Меню"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </Button>
        </div>
      </div>
      {menu && (
        <div
          className="mobile-nav"
          onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)}
        >
          <div className="mobile-nav-panel" role="dialog" aria-label="Меню">
            <div className="row between">
              <span className="logo">
                Content<b>Agents</b>
              </span>
              <Button
                variant="ghost"
                className="btn-icon"
                aria-label="Закрыть меню"
                onClick={() => setMenu(false)}
              >
                <Icon name="close" />
              </Button>
            </div>
            <nav aria-label="Разделы">
              {nav.map((n) => (
                <Link key={n.to} to={n.to} className={n.active ? 'active' : ''}>
                  <span className="row">
                    <Icon name={n.icon} /> {n.label}
                  </span>
                  {n.badge ? <span className="badge">{n.badge}</span> : null}
                </Link>
              ))}
            </nav>
            <Link to="/tasks/new" className="btn btn-primary">
              <Icon name="plus" /> Новая задача
            </Link>
            <StopAllButton />
            <Button variant="ghost" onClick={onLogout}>
              <Icon name="logout" /> Выйти
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}

function Page({ path }: { path: string }) {
  if (path === '/') return <Agents />;
  if (path === '/tasks') return <Tasks />;
  if (path === '/tasks/new') return <NewTask />;
  if (path === '/approvals') return <Approvals />;
  if (path === '/spend') return <Spend />;
  if (path === '/agents/new') return <NewAgent />;
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
        <StoppedBanner />
        <Page path={path} />
      </main>
    </>
  );
}
