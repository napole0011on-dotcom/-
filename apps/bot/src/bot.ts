import { Bot, type Context } from 'grammy';
import type { Actor, Logger } from '@cms/core';
import type { DecisionResult } from '@cms/agents';
import { parseCallback } from './callbacks.js';

/** What the bot can do; implemented by the Workflow + a few queries (an interface keeps the bot testable). */
export interface BotActions {
  submitBrief(text: string, actor: Actor): Promise<{ taskId: string }>;
  decidePlan(
    taskId: string,
    action: 'approve' | 'change' | 'cancel',
    actor: Actor,
    comment?: string,
  ): Promise<DecisionResult>;
  decideArtifact(
    artifactId: string,
    action: 'approve' | 'revise' | 'regenerate',
    actor: Actor,
    opts?: { variant?: number | null; comment?: string | null },
  ): Promise<DecisionResult>;
  approveAll(taskId: string, actor: Actor): Promise<DecisionResult>;
  cancelTask(taskId: string, actor: Actor): Promise<DecisionResult>;
  approveBudget(taskId: string, extraUsd: number, actor: Actor): Promise<DecisionResult>;
  brandInfo(): Promise<string>;
  reloadBrand(): Promise<string>;
  listTasks(): Promise<string>;
  findTask(idPrefix: string): Promise<string | null>;
}

type Pending = { kind: 'plan_change'; taskId: string } | { kind: 'revise'; artifactId: string };

const HELP = [
  'Пришлите бриф обычным сообщением — например: «Подготовь контент-неделю для Instagram про осеннее меню».',
  '',
  '/tasks — последние задачи и их статусы',
  '/cancel <id> — отменить задачу (первые 8 символов id)',
  '/brand — профиль бренда; /brand reload — перечитать YAML',
  '/skip — отменить ввод комментария',
].join('\n');

export function createBot(
  token: string,
  ownerId: number,
  actions: BotActions,
  logger: Logger,
): Bot {
  const bot = new Bot(token);
  const actor: Actor = { kind: 'human', id: `tg:${ownerId}` };
  // Waiting for the owner's comment after "Изменить" / "Правка". In memory: after a restart just press the button again.
  const pending = new Map<number, Pending>();

  // Whitelist: only the owner, only in a private chat. Everyone else gets no reply at all.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId || (ctx.chat && ctx.chat.type !== 'private')) {
      logger.warn(
        { fromId: ctx.from?.id ?? null, chatType: ctx.chat?.type ?? null },
        'ignored update from non-owner',
      );
      return;
    }
    await next();
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));
  bot.command('skip', async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.reply('Ок, комментарий не нужен.');
  });
  bot.command('brand', async (ctx) => {
    await ctx.reply(
      ctx.match.trim() === 'reload' ? await actions.reloadBrand() : await actions.brandInfo(),
    );
  });
  bot.command('tasks', async (ctx) => ctx.reply(await actions.listTasks()));
  bot.command('cancel', async (ctx) => {
    const id = await actions.findTask(ctx.match.trim());
    if (!id) return ctx.reply('Задача не найдена. Формат: /cancel <первые символы id из /tasks>');
    return ctx.reply((await actions.cancelTask(id, actor)).message);
  });

  bot.on('callback_query:data', async (ctx) => {
    const c = parseCallback(ctx.callbackQuery.data);
    if (!c) return ctx.answerCallbackQuery({ text: 'Неизвестная кнопка' });
    let result: DecisionResult;
    if (c.type === 'plan' && c.action === 'change') {
      pending.set(ctx.chat!.id, { kind: 'plan_change', taskId: c.taskId });
      await ctx.answerCallbackQuery();
      return ctx.reply('Что изменить в плане? Напишите одним сообщением (или /skip).', {
        reply_markup: { force_reply: true },
      });
    }
    if (c.type === 'item' && c.action === 'revise') {
      pending.set(ctx.chat!.id, { kind: 'revise', artifactId: c.artifactId });
      await ctx.answerCallbackQuery();
      return ctx.reply('Что поправить в этом тексте? Напишите одним сообщением (или /skip).', {
        reply_markup: { force_reply: true },
      });
    }
    try {
      if (c.type === 'plan') result = await actions.decidePlan(c.taskId, c.action, actor);
      else if (c.type === 'item')
        result = await actions.decideArtifact(
          c.artifactId,
          c.action,
          actor,
          c.action === 'approve' ? { variant: c.variant } : {},
        );
      else if (c.type === 'task')
        result =
          c.action === 'approve_all'
            ? await actions.approveAll(c.taskId, actor)
            : await actions.cancelTask(c.taskId, actor);
      else result = await actions.approveBudget(c.taskId, c.extraUsd, actor);
    } catch (err) {
      logger.error({ err }, 'callback failed');
      return ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте ещё раз', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: result.message });
    if (result.ok) {
      await removeButtons(ctx);
      await ctx.reply(`➡️ ${result.message}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return ctx.reply(HELP);
    const p = pending.get(ctx.chat.id);
    if (p) {
      pending.delete(ctx.chat.id);
      const r =
        p.kind === 'plan_change'
          ? await actions.decidePlan(p.taskId, 'change', actor, text)
          : await actions.decideArtifact(p.artifactId, 'revise', actor, { comment: text });
      return ctx.reply(r.ok ? `➡️ ${r.message}` : `⚠️ ${r.message}`);
    }
    try {
      const { taskId } = await actions.submitBrief(text, actor);
      return ctx.reply(`Принял бриф. CEO готовит план (задача ${taskId.slice(0, 8)}).`);
    } catch (err) {
      return ctx.reply(`⚠️ ${(err as Error).message}`);
    }
  });

  bot.catch((err) => logger.error({ err: err.error }, 'bot handler error'));
  return bot;
}

async function removeButtons(ctx: Context) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // Message too old or already edited — not important.
  }
}
