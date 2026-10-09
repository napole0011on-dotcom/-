import { Api } from 'grammy';
import { cb } from '@cms/agents';
import type { Mirror } from './routes.js';

/** Telegram copy of panel decisions; does nothing when the bot is not configured. */
export function createMirror(botToken: string | undefined, ownerId: number | undefined): Mirror {
  if (!botToken || !ownerId) return { notify: () => Promise.resolve() };
  const api = new Api(botToken);
  return {
    async notify(text, reopenTaskId) {
      await api.sendMessage(
        ownerId,
        text,
        reopenTaskId
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '↩️ Вернуть на согласование',
                      callback_data: cb.task('ro', reopenTaskId),
                    },
                  ],
                ],
              },
            }
          : {},
      );
    },
  };
}
