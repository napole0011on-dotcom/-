import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveEvent } from './api';

export type LiveMode = 'connecting' | 'live' | 'polling';

/**
 * Live agent events over SSE (/api/events/stream). New events are merged into the ['events']
 * cache and the board is refreshed (debounced). If the stream fails, the caller polls instead;
 * the stream reconnects on its own (EventSource retry).
 */
export function useLiveEvents(onEvent?: (e: LiveEvent) => void): LiveMode {
  const qc = useQueryClient();
  const [mode, setMode] = useState<LiveMode>(() =>
    typeof EventSource === 'undefined' ? 'polling' : 'connecting',
  );
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  });
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events/stream');
    let refresh: ReturnType<typeof setTimeout> | null = null;
    es.onopen = () => setMode('live');
    es.onerror = () => setMode('polling');
    es.addEventListener('agent', (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
      qc.setQueryData<LiveEvent[]>(['events'], (old) =>
        [e, ...(old ?? []).filter((x) => x.id !== e.id)].slice(0, 50),
      );
      cb.current?.(e);
      if (refresh) clearTimeout(refresh);
      refresh = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['workspace'] });
        void qc.invalidateQueries({ queryKey: ['task-path'] });
        void qc.invalidateQueries({ queryKey: ['approvals'] });
      }, 300);
    });
    es.addEventListener('logout', () => {
      es.close();
      void qc.invalidateQueries();
    });
    return () => {
      if (refresh) clearTimeout(refresh);
      es.close();
    };
  }, [qc]);
  return mode;
}
