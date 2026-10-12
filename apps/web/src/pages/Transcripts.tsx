import { useMemo, useRef, useState } from 'react';
import { api, type TranscriptRow, type TranscriptStatus } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { useTranscript, useTranscripts } from '../queries';
import { navigate } from '../router';
import { Button, ConfirmButton, Empty, ErrorBox, Link, Loading, Pill, useAction } from '../ui';

const STATUS: Record<
  TranscriptStatus,
  { label: string; tone: 'muted' | 'accent' | 'success' | 'danger' }
> = {
  queued: { label: 'в очереди', tone: 'muted' },
  running: { label: 'расшифровывается', tone: 'accent' },
  done: { label: 'готово', tone: 'success' },
  failed: { label: 'ошибка', tone: 'danger' },
  cancelled: { label: 'остановлено', tone: 'muted' },
};

/** 75.2 -> "01:15", 3725 -> "1:02:05". */
export function clock(sec: number | null): string {
  if (sec === null) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

function Upload() {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const upload = useAction(
    (f: File) => {
      const form = new FormData();
      form.append('file', f, f.name);
      return api.post('/api/transcripts/upload', form);
    },
    () => {
      setName(null);
      if (input.current) input.current.value = '';
    },
  );
  return (
    <section className="card stack">
      <h2>Загрузить голосовое или видео</h2>
      <p className="small muted">
        Аудио: ogg, opus, mp3, m4a, wav. Видео: mp4, mov, mkv, webm. Файл расшифровывается в фоне;
        результат — текст с таймкодами и субтитры SRT/VTT. Голосовые можно присылать и боту в
        Telegram.
      </p>
      <div className="row wrap">
        <input
          ref={input}
          type="file"
          aria-label="Файл"
          accept="audio/*,video/*,.ogg,.oga,.opus,.mkv"
          onChange={(e) => setName(e.target.files?.[0]?.name ?? null)}
          style={{ width: 'auto', flex: '1 1 240px' }}
        />
        <Button
          variant="primary"
          disabled={!name}
          busy={upload.isPending}
          onClick={() => {
            const f = input.current?.files?.[0];
            if (f) upload.mutate(f);
          }}
        >
          <Icon name="plus" /> Расшифровать
        </Button>
      </div>
    </section>
  );
}

function Row({ t }: { t: TranscriptRow }) {
  const st = STATUS[t.status];
  return (
    <Link to={`/transcripts/${t.id}`} className="transcript-row">
      <div className="row between wrap">
        <b className="clamp-1">
          {t.kind === 'voice' ? '🎙' : '🎬'} {t.name}
        </b>
        <Pill tone={st.tone} live={t.status === 'running'}>
          {st.label}
          {t.status === 'running' ? ` · ${t.progress}%` : ''}
        </Pill>
      </div>
      {t.status === 'running' && (
        <div className="meter" aria-label={`Готово ${t.progress}%`}>
          <div style={{ width: `${t.progress}%` }} />
        </div>
      )}
      <div className="small muted clamp-2">
        {t.error ? <span className="danger">{t.error}</span> : t.preview || '…'}
      </div>
      <div className="small faint">
        {clock(t.durationSec)} · {t.source === 'telegram' ? 'из Telegram' : 'из панели'} ·{' '}
        {dateTime(t.createdAt)}
      </div>
    </Link>
  );
}

export function Transcripts() {
  const { data, error, isLoading } = useTranscripts();
  return (
    <>
      <div className="page-head">
        <h1>Расшифровки</h1>
      </div>
      <Upload />
      {isLoading && <Loading rows={2} />}
      <ErrorBox error={error} />
      {data && data.length === 0 && (
        <div className="card">
          <Empty icon="inbox">
            Пока нет расшифровок. Загрузите файл или пришлите голосовое боту.
          </Empty>
        </div>
      )}
      {data && data.length > 0 && (
        <div className="stack">
          {data.map((t) => (
            <Row key={t.id} t={t} />
          ))}
        </div>
      )}
    </>
  );
}

export function TranscriptPage({ id }: { id: string }) {
  const { data: t, error, isLoading } = useTranscript(id);
  const [q, setQ] = useState('');
  const [brief, setBrief] = useState('');
  const media = useRef<HTMLMediaElement | null>(null);
  const cancel = useAction(() => api.post(`/api/transcripts/${id}/cancel`));
  const toTask = useAction(
    (text: string | null) => api.post(`/api/transcripts/${id}/task`, { text }),
    (r) => r.ok && r.taskId && navigate(`/tasks/${r.taskId}`),
  );
  const shown = useMemo(() => {
    const segs = t?.segments ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? segs.filter((s) => s.text.toLowerCase().includes(needle)) : segs;
  }, [t, q]);
  if (isLoading) return <Loading />;
  if (!t) return <ErrorBox error={error ?? new Error('Расшифровка не найдена')} />;
  const st = STATUS[t.status];
  const seek = (sec: number) => {
    if (!media.current) return;
    media.current.currentTime = sec;
    void media.current.play().catch(() => undefined);
  };
  const src = `/api/transcripts/${t.id}/media`;
  return (
    <div className="stack">
      <div className="crumbs small">
        <Link to="/transcripts">Расшифровки</Link> /
      </div>
      <div className="page-head">
        <h1 className="clamp-1">{t.name}</h1>
        <Pill tone={st.tone} live={t.status === 'running'}>
          {st.label}
        </Pill>
      </div>
      {t.error && <div className="error-box">{t.error}</div>}
      {(t.status === 'running' || t.status === 'queued') && (
        <div className="card stack">
          <div>
            Готово кусков: {t.chunksDone} из {t.chunksTotal ?? '…'}
          </div>
          <div className="meter">
            <div
              style={{ width: `${t.chunksTotal ? (t.chunksDone / t.chunksTotal) * 100 : 0}%` }}
            />
          </div>
          <div className="row">
            <ConfirmButton
              label="Остановить"
              title="Остановить расшифровку?"
              text="Готовая часть сохранится, остальное расшифровываться не будет."
              confirmLabel="Да, остановить"
              busy={cancel.isPending}
              onConfirm={() => cancel.mutate(undefined)}
            />
          </div>
        </div>
      )}
      <section className="card stack">
        {t.mediaAvailable ? (
          t.kind === 'video' ? (
            <video
              ref={(el) => {
                media.current = el;
              }}
              src={src}
              controls
              preload="metadata"
              className="media-player"
            />
          ) : (
            <audio
              ref={(el) => {
                media.current = el;
              }}
              src={src}
              controls
              preload="metadata"
              className="media-player"
            />
          )
        ) : (
          <div className="muted small">Исходный файл удалён по сроку хранения; текст остался.</div>
        )}
        <div className="small muted">
          {clock(t.durationSec)} · язык {t.language ?? '—'} · движок {t.provider ?? '—'}
          {t.model ? ` (${t.model})` : ''} · файл хранится до {dateTime(t.mediaExpiresAt)}
        </div>
        {t.files.length > 0 && (
          <div className="row wrap">
            {t.files.map((f) => (
              <a
                key={f}
                className="btn btn-sm"
                href={`/api/transcripts/${t.id}/files/${f}`}
                download={f}
              >
                Скачать {f.split('.').pop()!.toUpperCase()}
              </a>
            ))}
          </div>
        )}
      </section>
      {t.status === 'done' && (
        <section className="card stack">
          <h2>Передать дальше</h2>
          <p className="small muted">
            Будет создана задача: CEO составит план, расшифровка пойдёт агентам как данные (не как
            инструкции). Связи «Голос/Видео → агент» на доске решают, кому именно.
          </p>
          <textarea
            rows={2}
            maxLength={8000}
            aria-label="Бриф"
            placeholder="Бриф (необязательно): например, «Сделай 3 идеи Reels по этому видео»"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <div className="row wrap">
            <Button
              variant="primary"
              busy={toTask.isPending}
              onClick={() => toTask.mutate(brief.trim() || null)}
            >
              В контент-задачу
            </Button>
            <Button
              busy={toTask.isPending}
              onClick={() =>
                toTask.mutate('Сделай идеи и сценарии Reels по этой расшифровке (во вложении).')
              }
            >
              В Reels-агента
            </Button>
          </div>
        </section>
      )}
      <section className="card stack">
        <div className="row between wrap">
          <h2>Текст</h2>
          <input
            type="search"
            aria-label="Поиск по тексту"
            placeholder="Поиск по тексту"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>
        {shown.length === 0 && (
          <div className="muted small">{q ? 'Ничего не найдено' : 'Текста пока нет'}</div>
        )}
        <ol className="segments">
          {shown.map((s, i) => (
            <li key={`${s.start}-${i}`}>
              <button
                type="button"
                className="segment"
                onClick={() => seek(s.start)}
                title="Перейти к этому месту"
              >
                <span className="tabular faint">{clock(s.start)}</span>
                <span>{s.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
