import type { Logger } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import { budgetStatus, type BudgetContext } from '@cms/engine';
import { getBrand, loadBrandProfileFile, upsertBrand, type Workflow } from '@cms/agents';
import type { BotActions } from './bot.js';

const STATUS_RU: Record<string, string> = {
  draft: 'черновик',
  planned: 'план готовится',
  awaiting_plan_approval: 'ждёт утверждения плана',
  in_progress: 'в работе',
  in_review: 'проверка Critic',
  revision: 'доработка',
  awaiting_final_approval: 'ждёт вашего согласования',
  approved: 'утверждено',
  rejected: 'отклонено',
  exported: 'экспортировано',
  published: 'опубликовано',
  failed: 'ошибка',
  cancelled: 'отменено',
};

export function makeActions(deps: {
  db: Db;
  workflow: Workflow;
  brandId: () => string;
  setBrandId: (id: string) => void;
  brandFile: string;
  budget: BudgetContext;
  logger: Logger;
}): BotActions {
  const { db, workflow } = deps;
  return {
    submitBrief: (text, actor) => workflow.submitBrief(deps.brandId(), text, actor),
    decidePlan: (id, a, actor, comment) => workflow.decidePlan(id, a, actor, comment),
    decideArtifact: (id, a, actor, opts) => workflow.decideArtifact(id, a, actor, opts),
    approveAll: (id, actor) => workflow.approveAll(id, actor),
    cancelTask: (id, actor) => workflow.cancelTask(id, actor),
    approveBudget: (id, usd, actor) => workflow.approveBudget(id, usd, actor),

    async brandInfo() {
      const b = await getBrand(db, deps.brandId());
      const p = b.profile;
      return [
        `Бренд: ${b.name} (slug ${b.slug}), версия профиля ${b.profileVersion}`,
        `Тон: ${p.tone.join('; ') || '—'}`,
        `Аудитория: ${p.audience.join('; ') || '—'}`,
        `Запретные слова: ${p.bannedWords.join(', ') || '—'}`,
        `Примеров текстов: ${p.examples.length}`,
        '',
        `Профиль берётся из файла ${deps.brandFile}. Поменяйте его и отправьте /brand reload.`,
      ].join('\n');
    },

    async reloadBrand() {
      try {
        const { brand, changed } = await upsertBrand(db, loadBrandProfileFile(deps.brandFile));
        deps.setBrandId(brand.id);
        return changed
          ? `Профиль обновлён: версия ${brand.profileVersion}.`
          : `Изменений нет (версия ${brand.profileVersion}).`;
      } catch (err) {
        return `⚠️ ${(err as Error).message}`;
      }
    },

    async listTasks() {
      const rows = await db
        .select()
        .from(schema.tasks)
        .orderBy(sql`${schema.tasks.createdAt} desc`)
        .limit(10);
      if (rows.length === 0) return 'Задач пока нет. Пришлите бриф сообщением.';
      const lines = [];
      for (const t of rows) {
        const spent = (await budgetStatus(db, deps.budget, t.brandId, t.id)).find(
          (s) => s.scope === 'task',
        )!;
        lines.push(
          `${t.id.slice(0, 8)} · ${STATUS_RU[t.status] ?? t.status}${t.pausedAt ? ` · ПАУЗА (${t.pauseReason})` : ''} · $${spent.spentUsd.toFixed(4)}\n   ${t.title}`,
        );
      }
      return lines.join('\n');
    },

    async findTask(prefix) {
      if (!/^[0-9a-f-]{4,36}$/.test(prefix)) return null;
      const rows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(sql`${schema.tasks.id}::text like ${prefix + '%'}`)
        .limit(2);
      return rows.length === 1 ? rows[0]!.id : null;
    },
  };
}
