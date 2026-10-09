import { unpricedModels, type AppConfig, type ModelPricing } from '@cms/core';

const PROVIDER_LABEL = {
  mock: 'mock (без вызовов API, $0)',
  anthropic: 'Anthropic API напрямую',
  tokenharbor: 'Token Harbor (шлюз)',
} as const;

/** Startup greeting: which provider and which model per role is active right now. */
export function describeLlmSetup(config: AppConfig, pricing: ModelPricing): string {
  const { llm } = config;
  const m = llm.models;
  const lines = [`LLM: ${PROVIDER_LABEL[llm.provider]}`];
  if (llm.baseUrl) lines.push(`Адрес шлюза: ${new URL(llm.baseUrl).host}`);
  lines.push(
    `Модели: CEO — ${m.ceo}; Copywriter — ${m.worker}; Critic — ${m.critic}; classifier — ${m.classifier}`,
    `Structured outputs: ${llm.structuredOutputs ? 'да (output_config.format)' : 'нет — схема в промпте, проверка Zod'}`,
  );
  if (llm.rateLimit.perMinute || llm.rateLimit.perHour) {
    lines.push(
      `Лимит запросов: ${llm.rateLimit.perMinute || '∞'}/мин, ${llm.rateLimit.perHour || '∞'}/час`,
    );
  }
  if (llm.provider !== 'mock') {
    lines.push(`Запас на расхождение учёта: ×${llm.costSafetyFactor}`);
    const unpriced = unpricedModels(pricing, Object.values(m));
    if (unpriced.length) {
      lines.push(
        `⚠️ Нет цены в ${pricingName(llm.pricingFile)}: ${unpriced.join(', ')} — считаю по максимальной ставке.`,
      );
    }
    const free = Object.values(m).filter((x) => {
      const p = pricing.models[x];
      return p && p.input === 0 && p.output === 0;
    });
    if (free.length)
      lines.push(
        `Бесплатные модели: ${[...new Set(free)].join(', ')} (расход $0; бесплатность может закончиться — следите за ценами).`,
      );
  }
  return lines.join('\n');
}

const pricingName = (file: string) => file.split(/[\\/]/).pop() ?? file;
