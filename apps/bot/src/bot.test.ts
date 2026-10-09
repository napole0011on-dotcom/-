import { describe, expect, it } from 'vitest';
import { createLogger, type Actor } from '@cms/core';
import type { BotActions } from './bot.js';
import { createBot } from './bot.js';
import { cb, parseCallback } from '@cms/agents';
import { esc, splitMessage } from './format.js';

const OWNER = 111;
const STRANGER = 999;
const logger = createLogger({ level: 'silent' });
const UUID = '0b3f6f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function harness() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const done: string[] = [];
  const ok = (m: string) => Promise.resolve({ ok: true, message: m });
  const actions: BotActions = {
    submitBrief: (text: string, actor: Actor) => (
      done.push(`brief:${text}:${actor.kind}`),
      Promise.resolve({ taskId: UUID })
    ),
    decidePlan: (id, a, _actor, comment) => (
      done.push(`plan:${a}:${comment ?? ''}`),
      ok('План утверждён')
    ),
    decideArtifact: (id, a, _actor, opts) => (
      done.push(`item:${a}:${opts?.variant ?? ''}:${opts?.comment ?? ''}`),
      ok('Утверждено')
    ),
    approveAll: () => (done.push('all'), ok('Утверждено: 2')),
    cancelTask: () => (done.push('cancel'), ok('Задача отменена')),
    rejectPackage: () => (done.push('reject'), ok('Пакет отклонён')),
    reopenPackage: () => (done.push('reopen'), ok('Пакет снова ждёт вашего решения')),
    approveBudget: (_id, usd) => (done.push(`budget:${usd}`), ok('Добавлено')),
    brandInfo: () => Promise.resolve('brand'),
    reloadBrand: () => Promise.resolve('reloaded'),
    listTasks: () => Promise.resolve('tasks'),
    findTask: () => Promise.resolve(null),
    reconcile: (text: string) => (done.push(`reconcile:${text}`), Promise.resolve('ok')),
  };
  const bot = createBot('123:TEST', OWNER, actions, logger);
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'bot',
    username: 'test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  // Intercept every outgoing Bot API call: no network in tests.
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload });
    return Promise.resolve({
      ok: true,
      result:
        method === 'sendMessage'
          ? { message_id: calls.length, date: 0, chat: { id: OWNER, type: 'private' } }
          : true,
    } as never);
  });
  let updateId = 1;
  const text = (from: number, t: string, chatType: 'private' | 'group' = 'private') =>
    bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat:
          chatType === 'private'
            ? { id: from, type: 'private', first_name: 'u' }
            : { id: -5, type: 'group', title: 'g' },
        from: { id: from, is_bot: false, first_name: 'u' },
        text: t,
        ...(t.startsWith('/')
          ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0]!.length }] }
          : {}),
      },
    });
  const press = (from: number, data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: from, is_bot: false, first_name: 'u' },
        chat_instance: 'x',
        data,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: from, type: 'private', first_name: 'u' },
          text: 'm',
        },
      },
    });
  return { calls, done, text, press };
}

describe('bot', () => {
  it('ignores everyone except the owner: no reply, no action', async () => {
    const h = harness();
    await h.text(STRANGER, 'Сделай мне контент-план на неделю');
    await h.press(STRANGER, cb.plan('ok', UUID));
    await h.text(OWNER, 'Сделай мне контент-план в группе', 'group');
    expect(h.calls).toEqual([]);
    expect(h.done).toEqual([]);
  });

  it('owner brief creates a task and confirms', async () => {
    const h = harness();
    await h.text(OWNER, 'Подготовь пост про осеннее меню');
    expect(h.done).toEqual(['brief:Подготовь пост про осеннее меню:human']);
    expect(h.calls.at(-1)?.payload.text).toMatch(/Принял бриф/);
  });

  it('plan buttons: approve directly; "change" asks for a comment and passes it on', async () => {
    const h = harness();
    await h.press(OWNER, cb.plan('ok', UUID));
    expect(h.done).toEqual(['plan:approve:']);
    expect(h.calls.map((c) => c.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
      'sendMessage',
    ]);

    await h.press(OWNER, cb.plan('ch', UUID));
    expect(h.calls.at(-1)?.payload).toMatchObject({ reply_markup: { force_reply: true } });
    await h.text(OWNER, 'Добавь Reels');
    expect(h.done.at(-1)).toBe('plan:change:Добавь Reels');
  });

  it('item buttons: variant approval, edit with comment, regenerate, budget', async () => {
    const h = harness();
    await h.press(OWNER, cb.item('v2', UUID));
    await h.press(OWNER, cb.item('re', UUID));
    await h.press(OWNER, cb.item('ed', UUID));
    await h.text(OWNER, 'Короче');
    await h.press(OWNER, cb.budget(5, UUID));
    await h.press(OWNER, cb.task('all', UUID));
    expect(h.done).toEqual([
      'item:approve:2:',
      'item:regenerate::',
      'item:revise::Короче',
      'budget:5',
      'all',
    ]);
  });

  it('reject asks for confirmation; "No" changes nothing; "Yes" rejects and offers to undo', async () => {
    const h = harness();
    await h.press(OWNER, cb.task('rj', UUID));
    expect(h.done).toEqual([]);
    const confirm = h.calls.at(-1)!.payload as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(confirm.text).toMatch(/Точно отклонить/);
    const [yes, no] = confirm.reply_markup.inline_keyboard[0]!;
    await h.press(OWNER, no!.callback_data);
    expect(h.done).toEqual([]);
    await h.press(OWNER, yes!.callback_data);
    expect(h.done).toEqual(['reject']);
    const after = h.calls.at(-1)!.payload as {
      reply_markup: { inline_keyboard: { callback_data: string }[][] };
    };
    expect(after.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe(cb.task('ro', UUID));
    await h.press(OWNER, cb.task('ro', UUID));
    expect(h.done).toEqual(['reject', 'reopen']);
  });

  it('/reconcile passes the balance text through', async () => {
    const h = harness();
    await h.text(OWNER, '/reconcile 12.34');
    expect(h.done).toEqual(['reconcile:12.34']);
  });

  it('/skip drops a pending comment; the next text is a new brief', async () => {
    const h = harness();
    await h.press(OWNER, cb.plan('ch', UUID));
    await h.text(OWNER, '/skip');
    await h.text(OWNER, 'Новый бриф про зимние напитки');
    expect(h.done).toEqual(['brief:Новый бриф про зимние напитки:human']);
  });
});

describe('callbacks and formatting', () => {
  it('every payload fits the 64-byte Telegram limit and round-trips', () => {
    const all = [
      cb.plan('ok', UUID),
      cb.plan('ch', UUID),
      cb.plan('no', UUID),
      cb.item('ok', UUID),
      cb.item('v1', UUID),
      cb.item('v3', UUID),
      cb.item('ed', UUID),
      cb.item('re', UUID),
      cb.task('all', UUID),
      cb.task('rj', UUID),
      cb.task('ry', UUID),
      cb.task('ro', UUID),
      cb.task('no', UUID),
      cb.budget(1, UUID),
      cb.budget(5, UUID),
    ];
    for (const d of all) {
      expect(Buffer.byteLength(d, 'utf8'), d).toBeLessThanOrEqual(64);
      expect(parseCallback(d), d).not.toBeNull();
    }
    expect(parseCallback('a:v9:' + UUID)).toBeNull();
    expect(parseCallback('p:ok:not-a-uuid')).toBeNull();
  });

  it('escapes HTML and splits long messages under 4096 chars', () => {
    expect(esc('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
    const parts = splitMessage(Array.from({ length: 5 }, (_, i) => `${i}`.repeat(1500)));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join('\n\n').replace(/\n/g, '')).toBe(
      Array.from({ length: 5 }, (_, i) => `${i}`.repeat(1500)).join(''),
    );
  });
});
