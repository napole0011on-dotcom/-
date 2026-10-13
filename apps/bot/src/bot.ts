import { Bot, type Context } from 'grammy';
import type { Actor, Logger } from '@cms/core';
import type { DecisionResult } from '@cms/agents';
import { cb, parseCallback } from '@cms/agents';

/** Placeholder id for the "No" button of the rejection confirmation. */
const NO_TASK = '00000000-0000-0000-0000-000000000000';

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
  rejectPackage(taskId: string, actor: Actor): Promise<DecisionResult>;
  reopenPackage(taskId: string, actor: Actor): Promise<DecisionResult>;
  approveBudget(taskId: string, extraUsd: number, actor: Actor): Promise<DecisionResult>;
  continueTask(taskId: string, actor: Actor): Promise<DecisionResult>;
  brandInfo(): Promise<string>;
  reloadBrand(): Promise<string>;
  listTasks(): Promise<string>;
  findTask(idPrefix: string): Promise<string | null>;
  reconcile(balanceText: string, actor: Actor): Promise<string>;
  /** Voice message -> stored file + transcription in the queue (reply comes when it is done). */
  transcribeVoice(
    file: { name: string; mimeType: string; data: Buffer },
    chatId: number,
    actor: Actor,
  ): Promise<DecisionResult>;
  transcriptToTask(transcriptId: string, actor: Actor): Promise<DecisionResult>;
}

type Pending = { kind: 'plan_change'; taskId: string } | { kind: 'revise'; artifactId: string };

const HELP = [
  'Пришлите бриф обычным сообщением — например: «Подготовь контент-неделю для Instagram про осеннее меню».',
  '',
  '/tasks — последние задачи и их статусы',
  '/cancel <id> — отменить задачу (первые 8 символов id)',
  '/brand — профиль бренда; /brand reload — перечитать YAML',
  '/reconcile 12.34 — сверить учёт расходов с балансом кошелька провайдера',
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
  bot.command('reconcile', async (ctx) =>
    ctx.reply(await actions.reconcile(ctx.match.trim(), actor)),
  );
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
    if (c.type === 'task' && c.action === 'reject_ask') {
      // Destructive: ask once more, like the confirmation dialog in the panel.
      await ctx.answerCallbackQuery();
      return ctx.reply(
        'Точно отклонить весь пакет? Вернуть можно, пока ничего не экспортировано.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✖️ Да, отклонить', callback_data: cb.task('ry', c.taskId) },
                { text: 'Нет', callback_data: cb.task('ro', NO_TASK) },
              ],
            ],
          },
        },
      );
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
      else if (c.type === 'task') {
        if (c.action === 'reopen' && c.taskId === NO_TASK) {
          await ctx.answerCallbackQuery({ text: 'Ок, ничего не меняю' });
          return removeButtons(ctx);
        }
        result =
          c.action === 'approve_all'
            ? await actions.approveAll(c.taskId, actor)
            : c.action === 'reject'
              ? await actions.rejectPackage(c.taskId, actor)
              : c.action === 'reopen'
                ? await actions.reopenPackage(c.taskId, actor)
                : c.action === 'resume'
                  ? await actions.continueTask(c.taskId, actor)
                  : await actions.cancelTask(c.taskId, actor);
      } else if (c.type === 'transcript') {
        result =
          c.action === 'task'
            ? await actions.transcriptToTask(c.transcriptId, actor)
            : { ok: true, message: 'Оставил в «Расшифровках» панели' };
      } else result = await actions.approveBudget(c.taskId, c.extraUsd, actor);
    } catch (err) {
      logger.error({ err }, 'callback failed');
      return ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте ещё раз', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: result.message });
    if (result.ok) {
      await removeButtons(ctx);
      if (c.type === 'task' && c.action === 'reject') {
        await ctx.reply(`➡️ ${result.message}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '↩️ Вернуть на согласование', callback_data: cb.task('ro', c.taskId) }],
            ],
          },
        });
      } else {
        await ctx.reply(`➡️ ${result.message}`);
      }
    }
  });

  // Voice messages and audio files -> text. Bot API lets a bot download files up to 20 MB
  // (TODO(verify) against core.telegram.org/bots/api#getfile; VOICE_MAX_MB is checked too).
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const m = ctx.message.voice ?? ctx.message.audio;
    if ((m.file_size ?? 0) > 20 * 1024 * 1024)
      return ctx.reply('Файл больше 20 МБ — бот не может его скачать. Загрузите его в панели.');
    try {
      const file = await ctx.getFile();
      if (!file.file_path) return ctx.reply('Telegram не отдал файл, попробуйте ещё раз');
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!res.ok) return ctx.reply('Не удалось скачать голосовое, попробуйте ещё раз');
      const data = Buffer.from(await res.arrayBuffer());
      const ext = file.file_path.split('.').pop() ?? 'ogg';
      const r = await actions.transcribeVoice(
        { name: `voice-${m.file_unique_id}.${ext}`, mimeType: m.mime_type ?? 'audio/ogg', data },
        ctx.chat.id,
        actor,
      );
      return ctx.reply(r.ok ? `🎙 ${r.message}` : `⚠️ ${r.message}`);
    } catch (err) {
      logger.error({ err }, 'voice failed');
      return ctx.reply('Не получилось обработать голосовое, попробуйте ещё раз');
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
