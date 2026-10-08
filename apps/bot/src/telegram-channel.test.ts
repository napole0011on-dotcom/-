import { Api } from 'grammy';
import { describe, expect, it } from 'vitest';
import type { PackageItemView } from '@cms/agents';
import { TelegramChannel } from './telegram-channel.js';

const UUID = '0b3f6f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function fakeApi() {
  const api = new Api('123:TEST');
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload });
    return Promise.resolve({
      ok: true,
      result: { message_id: calls.length, date: 0, chat: { id: 1, type: 'private' } },
    } as never);
  });
  return { api, calls };
}

const ok = { ok: true, comment: '' };
const longVariant = (n: number) => ({
  angle: `заход ${n}`,
  hook: `Хук <${n}> & co`,
  body: 'т'.repeat(2000),
  cta: 'Сохрани',
});
const item: PackageItemView = {
  artifactId: UUID,
  version: 2,
  deliverable: {
    id: 'reels-1',
    platform: 'instagram_reels',
    topic: 'тема',
    goal: 'охват',
    notes: '',
  },
  item: {
    deliverableId: 'reels-1',
    variants: [longVariant(1), longVariant(2), longVariant(3)],
    slides: null,
    reelsScript: [
      { fromSec: 0, toSec: 3, visual: 'кадр', voiceover: 'голос', onScreenText: 'текст' },
    ],
  },
  critic: {
    deliverableId: 'reels-1',
    verdict: 'fail',
    passed: false,
    checks: {
      briefFit: ok,
      brandVoice: { ok: false, comment: 'сухо' },
      clichesAndBureaucratese: ok,
      facts: ok,
      lengthAndFormat: ok,
    },
    issues: [{ variant: 1, problem: 'сухо', fix: 'живее' }],
    summary: 'нужно живее',
  },
  criticRound: 3,
  criticRejected: true,
  ownerComment: 'Короче',
};

describe('TelegramChannel', () => {
  it('sends plan with 3 gate buttons, all to the owner, HTML-safe', async () => {
    const { api, calls } = fakeApi();
    await new TelegramChannel(api, 42).sendPlan({
      taskId: UUID,
      title: 'Неделя <осень>',
      planArtifactId: UUID,
      version: 1,
      plan: {
        summary: 'Сделаем 1 Reels',
        assumptions: ['a'],
        questions: ['q?'],
        deliverables: [item.deliverable],
      },
      estimate: {
        expectedUsd: 0.12,
        maxUsd: 0.4,
        expectedMinutes: 2,
        steps: [{ agent: 'copywriter', what: 'тексты' }],
      },
      spentUsd: 0.01,
      taskBudgetUsd: 2,
    });
    expect(calls).toHaveLength(1);
    const p = calls[0]!.payload;
    expect(p).toMatchObject({ chat_id: 42, parse_mode: 'HTML' });
    expect(String(p.text)).toMatch(/Неделя &lt;осень&gt;/);
    expect(String(p.text)).toMatch(/максимум ~\$0\.40.*Лимит задачи \$2\.00/s);
    const kb = (p.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(['✅ Утвердить', '✏️ Изменить', '✖️ Отменить']);
  });

  it('long items are split under the 4096 limit; buttons only on the last part; critic rejection is visible', async () => {
    const { api, calls } = fakeApi();
    await new TelegramChannel(api, 42).sendPackage({
      taskId: UUID,
      title: 't',
      items: [item],
      pendingCount: 2,
      totalCount: 2,
      spentUsd: 0.3,
      taskBudgetUsd: 2,
      isUpdate: true,
    });
    const texts = calls.map((c) => String(c.payload.text));
    expect(texts.every((t) => t.length <= 4096)).toBe(true);
    expect(texts.join('\n')).toMatch(/Critic НЕ одобрил/);
    expect(texts.join('\n')).toMatch(/Ваш комментарий учтён: «Короче»/);
    expect(texts.join('\n')).toMatch(/Хук &lt;1&gt; &amp; co/);
    const withButtons = calls.filter((c) => c.payload.reply_markup);
    expect(withButtons).toHaveLength(2); // the item (last part) + "approve all remaining"
  });

  it('export sends a summary and the package file', async () => {
    const { api, calls } = fakeApi();
    await new TelegramChannel(api, 42).sendExport({
      taskId: UUID,
      title: 't',
      dir: 'C:\\data\\exports\\x',
      files: [{ name: 'package.md', content: Buffer.from('# hi') }],
      spentUsd: 0.25,
    });
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendDocument']);
    expect(String(calls[0]!.payload.text)).toMatch(/Публикация выключена/);
  });

  it('plain notifications (budget pause) carry buttons', async () => {
    const { api, calls } = fakeApi();
    await new TelegramChannel(api, 42).send({
      text: 'пауза',
      buttons: [[{ text: '+$1', data: `b:1:${UUID}` }]],
    });
    expect(calls[0]!.payload).toMatchObject({
      text: 'пауза',
      reply_markup: { inline_keyboard: [[{ text: '+$1', callback_data: `b:1:${UUID}` }]] },
    });
  });
});
