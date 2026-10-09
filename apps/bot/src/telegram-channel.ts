import { InlineKeyboard, InputFile, type Api } from 'grammy';
import type { ExportView, OwnerChannel, PackageView, PlanView } from '@cms/agents';
import type { NotifierMessage } from '@cms/providers';
import { cb } from '@cms/agents';
import { esc, renderItem, renderPackageHeader, renderPlan } from './format.js';

/** Sends everything to the single owner chat. */
export class TelegramChannel implements OwnerChannel {
  readonly name = 'telegram';

  constructor(
    private readonly api: Api,
    private readonly ownerId: number,
  ) {}

  private async sendHtml(chunks: string[], keyboard?: InlineKeyboard) {
    let last = 0;
    for (const [i, text] of chunks.entries()) {
      const isLast = i === chunks.length - 1;
      const m = await this.api.sendMessage(this.ownerId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
      });
      last = m.message_id;
    }
    return last;
  }

  /** Plain notifications (budget, errors, reminders): no HTML, optional buttons. */
  async send(msg: NotifierMessage) {
    const keyboard = msg.buttons
      ? InlineKeyboard.from(
          msg.buttons.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))),
        )
      : undefined;
    const m = await this.api.sendMessage(
      this.ownerId,
      msg.text,
      keyboard ? { reply_markup: keyboard } : {},
    );
    return { messageId: String(m.message_id) };
  }

  async sendPlan(v: PlanView) {
    const kb = new InlineKeyboard()
      .text('✅ Утвердить', cb.plan('ok', v.taskId))
      .text('✏️ Изменить', cb.plan('ch', v.taskId))
      .text('✖️ Отменить', cb.plan('no', v.taskId));
    await this.sendHtml(renderPlan(v), kb);
  }

  async sendPackage(v: PackageView) {
    await this.sendHtml([renderPackageHeader(v)]);
    for (const it of v.items) {
      const kb = new InlineKeyboard()
        .text('✅ 1', cb.item('v1', it.artifactId))
        .text('✅ 2', cb.item('v2', it.artifactId))
        .text('✅ 3', cb.item('v3', it.artifactId))
        .text('✅ все', cb.item('ok', it.artifactId))
        .row()
        .text('✏️ Правка с комментарием', cb.item('ed', it.artifactId))
        .text('🔄 Заново', cb.item('re', it.artifactId));
      await this.sendHtml(renderItem(it), kb);
    }
    // Whole-package actions, same as in the web panel.
    const kb = new InlineKeyboard();
    if (v.pendingCount > 1) kb.text('✅ Утвердить всё оставшееся', cb.task('all', v.taskId)).row();
    kb.text('✖️ Отклонить пакет', cb.task('rj', v.taskId));
    await this.sendHtml([`Ждут решения: ${v.pendingCount} из ${v.totalCount}.`], kb);
  }

  async sendExport(v: ExportView) {
    await this.sendHtml([
      `<b>Готово: ${esc(v.title)}</b>\nПакет сохранён в папку:\n<code>${esc(v.dir)}</code>\nСтоимость: $${v.spentUsd.toFixed(4)}. Публикация выключена — только экспорт.`,
    ]);
    for (const f of v.files)
      await this.api.sendDocument(this.ownerId, new InputFile(f.content, f.name));
  }
}
