import { useState } from 'react';
import { api, type CampaignView, type MailingData } from '../api';
import { dateTime } from '../format';
import { Icon } from '../icons';
import { useMailing } from '../queries';
import { Button, ConfirmButton, Empty, ErrorBox, Loading, Pill, useAction } from '../ui';

type Tab = 'letter' | 'list' | 'test' | 'send';
const TABS: { id: Tab; label: string }[] = [
  { id: 'letter', label: 'Письмо' },
  { id: 'list', label: 'Список' },
  { id: 'test', label: 'Тест' },
  { id: 'send', label: 'Отправка' },
];

const STATUS: Record<CampaignView['status'], string> = {
  draft: 'черновик — нужен тест',
  tested: 'тест отправлен — ждёт вашего подтверждения',
  confirmed: 'подтверждена, в очереди',
  sending: 'отправляется',
  stopping: 'останавливается',
  stopped: 'остановлена',
  done: 'отправлена',
};

/** «Рассылка»: letter → list with consent → test to you → «Отправить N адресам» → report. */
export function Mailing() {
  const { data, error, isLoading } = useMailing();
  const [tab, setTab] = useState<Tab>('letter');
  const [picked, setPicked] = useState<string | null>(null);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const current = data.campaigns.find((c) => c.id === picked) ?? data.campaigns[0] ?? null;
  return (
    <>
      <div className="page-head">
        <h1>Рассылка</h1>
        {data.provider === 'mock' && <Pill tone="muted">mock: письма никуда не уходят</Pill>}
      </div>
      {data.campaigns.length > 1 && (
        <div className="row wrap">
          <label htmlFor="campaign" className="small">
            Рассылка
          </label>
          <select
            id="campaign"
            value={current?.id ?? ''}
            onChange={(e) => setPicked(e.target.value)}
            style={{ maxWidth: 420 }}
          >
            {data.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} — {STATUS[c.status]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'letter' && <Letter data={data} current={current} onCreated={setPicked} />}
      {tab === 'list' && <Audience data={data} />}
      {tab === 'test' && <TestTab data={data} current={current} />}
      {tab === 'send' && <SendTab data={data} current={current} />}
    </>
  );
}

function Letter({
  data,
  current,
  onCreated,
}: {
  data: MailingData;
  current: CampaignView | null;
  onCreated: (id: string) => void;
}) {
  const create = useAction(
    (artifactId: string) => api.post('/api/mailing/campaigns', { artifactId }),
    (r) => r.ok && r.id && onCreated(r.id),
  );
  return (
    <div className="stack">
      <section className="card stack">
        <h2>Новая рассылка из утверждённого письма</h2>
        <p className="small muted">
          Письмо пишет агент «Письмо» в обычной задаче, вы утверждаете его в «Согласовании». В
          письме обязательна ссылка отписки <code>{'{{unsubscribe_url}}'}</code>; поля подстановки —
          только <code>{'{{name}}'}</code> и <code>{'{{unsubscribe_url}}'}</code>.
        </p>
        {data.drafts.length === 0 ? (
          <Empty icon="inbox">
            Нет утверждённых писем. Соедините на доске «CEO → Письмо» и поставьте задачу.
          </Empty>
        ) : (
          data.drafts.map((d) => (
            <div key={d.artifactId} className="row between wrap">
              <div>
                <b>{d.subject || 'Без темы'}</b>
                <div className="small muted">
                  {d.task} · {dateTime(d.createdAt)}
                </div>
              </div>
              <Button busy={create.isPending} onClick={() => create.mutate(d.artifactId)}>
                Сделать рассылку
              </Button>
            </div>
          ))
        )}
      </section>
      {current && (
        <section className="card stack">
          <div className="row between wrap">
            <h2>{current.subject}</h2>
            <Pill tone="neutral">{STATUS[current.status]}</Pill>
          </div>
          <div className="mail-preview small">{current.bodyText}</div>
        </section>
      )}
    </div>
  );
}

function Audience({ data }: { data: MailingData }) {
  const [csv, setCsv] = useState('');
  const load = useAction(
    (text: string) => api.post('/api/mailing/contacts', { csv: text }),
    (r) => r.ok && setCsv(''),
  );
  const a = data.audience;
  return (
    <div className="stack">
      <section className="card stack">
        <h2>Кому уйдёт письмо</h2>
        <div className="big-number tabular">{a.eligible}</div>
        <div className="small muted">
          адресов с согласием, без отписок. Всего в базе {a.total}: без отметки согласия{' '}
          {a.withoutConsent} (им не отправляется), отписались {a.unsubscribed}, в списке исключений{' '}
          {a.suppressed}.
        </div>
      </section>
      <section className="card stack">
        <h2>Загрузить контакты (CSV)</h2>
        <p className="small muted">
          Колонки: <code>email,name,consent_at,consent_source</code>. Письма получают только те, у
          кого есть дата согласия и его источник (ФЗ «О рекламе», ст. 18 — согласие доказывает
          отправитель; нужна консультация юриста). Адреса не пишутся в журнал — только количество.
        </p>
        <textarea
          rows={6}
          aria-label="CSV"
          spellCheck={false}
          placeholder={
            'email,name,consent_at,consent_source\nanna@example.com,Анна,2026-09-01,форма на сайте'
          }
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div className="row">
          <Button
            variant="primary"
            disabled={csv.trim().length < 5}
            busy={load.isPending}
            onClick={() => load.mutate(csv)}
          >
            Загрузить
          </Button>
        </div>
      </section>
    </div>
  );
}

function TestTab({ data, current }: { data: MailingData; current: CampaignView | null }) {
  const send = useAction((id: string) => api.post(`/api/mailing/campaigns/${id}/test`));
  if (!current) return <NoCampaign />;
  return (
    <section className="card stack">
      <h2>Тестовое письмо себе</h2>
      <p className="small muted">
        Перед отправкой списку письмо уходит вам (адрес <code>MAIL_TEST_TO</code> в .env:{' '}
        {data.testTo ? 'задан' : 'не задан'}). Проверьте тему, текст и ссылку отписки.
      </p>
      {current.testSentAt && (
        <div className="success-box">Тест отправлен {dateTime(current.testSentAt)}</div>
      )}
      <div className="row">
        <Button
          variant="primary"
          disabled={!['draft', 'tested'].includes(current.status)}
          busy={send.isPending}
          onClick={() => send.mutate(current.id)}
        >
          <Icon name="test" /> Отправить тест себе
        </Button>
      </div>
    </section>
  );
}

function SendTab({ data, current }: { data: MailingData; current: CampaignView | null }) {
  const confirm = useAction((v: { id: string; n: number }) =>
    api.post(`/api/mailing/campaigns/${v.id}/confirm`, { recipients: v.n }),
  );
  const stop = useAction((id: string) => api.post(`/api/mailing/campaigns/${id}/stop`));
  if (!current) return <NoCampaign />;
  const n = data.audience.eligible;
  const r = current.report;
  const total = current.recipients ?? 0;
  const done = r.sent + r.failed + r.stopped + r.suppressed;
  const running = ['confirmed', 'sending', 'stopping'].includes(current.status);
  return (
    <section className="card stack">
      <h2>Отправка</h2>
      <div className="small muted">
        Пачками по {data.limits.batchSize} с паузой {data.limits.batchPauseSeconds} с; не больше{' '}
        {data.limits.maxPerDay} писем в сутки. Каждый адрес получает письмо один раз.
      </div>
      {current.status === 'tested' && (
        <ConfirmButton
          label={`Отправить ${n} адресам`}
          variant="primary"
          title={`Отправить письмо ${n} адресам?`}
          text={
            data.provider === 'mock'
              ? `Режим mock: письма никуда не уйдут, будет только отчёт. Тема: «${current.subject}».`
              : `Письмо «${current.subject}» уйдёт ${n} адресатам с согласием. Отменить уже отправленное нельзя; остановить можно в любой момент.`
          }
          confirmLabel={`Да, отправить ${n}`}
          danger={data.provider !== 'mock'}
          disabled={n === 0}
          busy={confirm.isPending}
          onConfirm={() => confirm.mutate({ id: current.id, n })}
        />
      )}
      {current.status === 'draft' && (
        <div className="warn small">Сначала отправьте тестовое письмо себе (вкладка «Тест»).</div>
      )}
      {(running || ['done', 'stopped'].includes(current.status)) && (
        <>
          <div className="row between">
            <b>{STATUS[current.status]}</b>
            <span className="tabular">
              {done} / {total}
            </span>
          </div>
          <div className="meter">
            <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <dl className="facts">
            <dt>Доставлено</dt>
            <dd className="tabular">{r.sent}</dd>
            <dt>Ошибки</dt>
            <dd className="tabular">{r.failed}</dd>
            <dt>Остановлено</dt>
            <dd className="tabular">{r.stopped}</dd>
            <dt>Исключены (отписка)</dt>
            <dd className="tabular">{r.suppressed}</dd>
            <dt>В очереди</dt>
            <dd className="tabular">{r.queued}</dd>
          </dl>
        </>
      )}
      {running && current.status !== 'stopping' && (
        <ConfirmButton
          label={
            <>
              <Icon name="stop" /> Остановить рассылку
            </>
          }
          variant="danger"
          title="Остановить рассылку?"
          text="Неотправленные письма не уйдут (статус «остановлено»). Уже отправленные вернуть нельзя."
          confirmLabel="Да, остановить"
          danger
          busy={stop.isPending}
          onConfirm={() => stop.mutate(current.id)}
        />
      )}
    </section>
  );
}

function NoCampaign() {
  return (
    <div className="card">
      <Empty icon="inbox">Сначала создайте рассылку на вкладке «Письмо».</Empty>
    </div>
  );
}
