import type { LlmRequest, LlmResponse, LlmTransport } from '@cms/engine';
import type { CeoPlan, CopyItem, Deliverable, Review } from './schemas.js';

/**
 * LLM_PROVIDER=mock: canned, schema-valid answers for every agent, no network, $0.
 * Lets you click through the whole bot flow before spending anything.
 * The agent is recognised by the output schema title; inputs are read from the prompt.
 */
export class MockLlmTransport implements LlmTransport {
  calls = 0;

  create(params: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const title = (params.output_config?.format?.schema as { title?: string } | undefined)?.title;
    const prompt = promptText(params);
    let body: unknown;
    if (title === 'CeoPlan') body = mockPlan(prompt);
    else if (title === 'CopywriterOutput') body = mockCopy(prompt);
    else if (title === 'CriticOutput') body = mockCritic(prompt);
    else body = {};
    return Promise.resolve({
      id: `mock_${this.calls}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        iterations: null,
      },
    } as unknown as LlmResponse);
  }
}

function promptText(params: LlmRequest): string {
  const last = [...params.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string'
    ? last.content
    : last.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

function mockPlan(prompt: string): CeoPlan {
  const reels = /reels|рилс|ролик/i.test(prompt);
  const comment = /Комментарий владельца[^\n]*\n([^\n]+)/.exec(prompt)?.[1];
  const deliverables: Deliverable[] = [
    reels
      ? {
          id: 'reels-1',
          platform: 'instagram_reels',
          topic: 'Главная мысль брифа в коротком ролике',
          goal: 'охват',
          notes: '',
        }
      : {
          id: 'post-1',
          platform: 'instagram_post',
          topic: 'Главная мысль брифа',
          goal: 'сохранения',
          notes: '',
        },
    {
      id: 'tg-1',
      platform: 'telegram_post',
      topic: 'Та же тема подробнее для Telegram',
      goal: 'вовлечение',
      notes: '',
    },
  ];
  return {
    summary: `[MOCK] Копирайтер напишет ${deliverables.length} текста по брифу, критик проверит каждый.${comment ? ` Учтён комментарий: ${comment}` : ''}`,
    assumptions: ['[MOCK] ответ сгенерирован без LLM (LLM_PROVIDER=mock)'],
    questions: [],
    deliverables,
  };
}

function mockCopy(prompt: string): { items: CopyItem[] } {
  const json = /<deliverables_json>([\s\S]*?)<\/deliverables_json>/.exec(prompt)?.[1] ?? '[]';
  const deliverables = JSON.parse(json) as Deliverable[];
  const comment = /Комментарий владельца \(главное\):\n([^\n]+)/.exec(prompt)?.[1];
  const fresh = /написать заново/.test(prompt);
  return {
    items: deliverables.map((d) => ({
      deliverableId: d.id,
      variants: [1, 2, 3].map((n) => ({
        angle: ['через боль', 'через историю', 'через пользу'][n - 1]!,
        hook: `[MOCK${fresh ? ', заново' : ''}] Вариант ${n}: ${d.topic}`.slice(0, 120),
        body: `Тестовый текст для «${d.topic}». Здесь будет живой текст от копирайтера.${comment ? `\nУчтено: ${comment}` : ''}`,
        cta: 'Сохрани, чтобы не потерять',
      })),
      slides: d.platform === 'instagram_carousel' ? ['Слайд 1', 'Слайд 2', 'Слайд 3'] : null,
      reelsScript:
        d.platform === 'instagram_reels'
          ? [
              {
                fromSec: 0,
                toSec: 3,
                visual: 'Крупный план',
                voiceover: 'Хук',
                onScreenText: 'Хватит листать',
              },
              {
                fromSec: 3,
                toSec: 15,
                visual: 'Демонстрация',
                voiceover: 'Суть',
                onScreenText: '3 шага',
              },
            ]
          : null,
    })),
  };
}

function mockCritic(prompt: string): { reviews: Review[] } {
  const ids = [...prompt.matchAll(/"deliverableId":\s*"([^"]+)"/g)].map((m) => m[1]!);
  const ok = { ok: true, comment: '[MOCK] ок' };
  return {
    reviews: [...new Set(ids)].map((id) => ({
      deliverableId: id,
      verdict: 'pass',
      checks: {
        briefFit: ok,
        brandVoice: ok,
        clichesAndBureaucratese: ok,
        facts: ok,
        lengthAndFormat: ok,
      },
      issues: [],
      summary: '[MOCK] проверка без LLM',
    })),
  };
}
