import { useState, type FormEvent } from 'react';
import { ApiError, api, type SessionInfo } from '../api';
import { dateTime } from '../format';
import { Button } from '../ui';

export function Login({ onLogin }: { onLogin: (s: SessionInfo) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.post<SessionInfo>('/api/login', { password }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const until = typeof err.body.lockedUntil === 'string' ? err.body.lockedUntil : null;
        setError(`Слишком много неверных попыток. Вход заблокирован до ${dateTime(until)}.`);
      } else if (err instanceof ApiError && err.status === 401) {
        const left = typeof err.body.attemptsLeft === 'number' ? err.body.attemptsLeft : null;
        setError(left !== null ? `Неверный пароль. Осталось попыток: ${left}` : 'Неверный пароль');
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось войти');
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <div className="logo">
          Content<span>Agents</span>
        </div>
        <label>
          Пароль
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={!password}>
          Войти
        </Button>
        <p className="muted small">
          Пароль задаётся командой <code>pnpm panel:password</code>, хэш хранится в{' '}
          <code>.env</code>.
        </p>
      </form>
    </div>
  );
}
