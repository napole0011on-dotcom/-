import { useSyncExternalStore } from 'react';

// A tiny History API router: the panel has a handful of flat routes, a dependency is not worth it.

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.scrollTo(0, 0);
  notify();
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
}

/** Matches "/tasks/:id" against a path; returns params or null. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const seg = s[i]!;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return params;
}
