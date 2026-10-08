import {
  CHECK_LABEL,
  CHECK_NAMES,
  PLATFORM_LABEL,
  type PackageItemView,
  type PackageView,
  type PlanView,
} from '@cms/agents';

/** Telegram limit: 4096 characters per message (after entity parsing). We keep a margin. */
export const MAX_MESSAGE = 4000;

/** HTML parse mode: <, > and & must be escaped (Bot API). */
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/** Splits on paragraph boundaries so HTML tags are never cut in half (each block is self-contained). */
export function splitMessage(blocks: string[], max = MAX_MESSAGE): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of blocks) {
    const pieces = raw.length > max ? hardSplit(raw, max) : [raw];
    for (const b of pieces) {
      if (cur && cur.length + 2 + b.length > max) {
        out.push(cur);
        cur = b;
      } else cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hardSplit(s: string, max: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
  return parts;
}

export function renderPlan(v: PlanView): string[] {
  const p = v.plan;
  const blocks = [
    `<b>План: ${esc(v.title)}</b> (версия ${v.version})`,
    esc(p.summary),
    [
      '<b>Что сделаем:</b>',
      ...p.deliverables.map(
        (d, i) =>
          `${i + 1}. <code>${esc(d.id)}</code> · ${PLATFORM_LABEL[d.platform]} — ${esc(d.topic)} (цель: ${esc(d.goal)})`,
      ),
    ].join('\n'),
    [
      '<b>Кто и в каком порядке:</b>',
      ...v.estimate.steps.map((s, i) => `${i + 1}. ${s.agent} — ${esc(s.what)}`),
    ].join('\n'),
  ];
  if (p.assumptions.length)
    blocks.push(['<b>Допущения:</b>', ...p.assumptions.map((a) => `• ${esc(a)}`)].join('\n'));
  if (p.questions.length)
    blocks.push(['<b>Вопросы к вам:</b>', ...p.questions.map((q) => `• ${esc(q)}`)].join('\n'));
  blocks.push(
    `<b>Расходы:</b> ожидаемо ~${usd(v.estimate.expectedUsd)}, максимум ~${usd(v.estimate.maxUsd)}. ` +
      `Лимит задачи ${usd(v.taskBudgetUsd)}, уже потрачено ${usd(v.spentUsd)}.`,
    `<b>Сроки:</b> ~${v.estimate.expectedMinutes} мин после утверждения.`,
  );
  return splitMessage(blocks);
}

export function renderPackageHeader(v: PackageView): string {
  const head = v.isUpdate
    ? `<b>Новая версия: ${esc(v.title)}</b>`
    : `<b>Пакет на согласование: ${esc(v.title)}</b>`;
  return [
    head,
    `Текстов: ${v.totalCount}, ждут решения: ${v.pendingCount}. Потрачено ${usd(v.spentUsd)} из ${usd(v.taskBudgetUsd)}.`,
    'По каждому тексту: ✅ — утвердить (можно выбрать вариант), ✏️ — правка с комментарием, 🔄 — написать заново.',
  ].join('\n');
}

export function renderItem(it: PackageItemView): string[] {
  const c = it.critic;
  const verdict = c.passed
    ? `✅ Critic одобрил (раунд ${it.criticRound})`
    : it.criticRejected
      ? `⚠️ <b>Critic НЕ одобрил</b> после 2 доработок`
      : `⚠️ Critic: есть замечания`;
  const blocks = [
    `<b>${esc(it.deliverable.id)} · ${PLATFORM_LABEL[it.deliverable.platform]}</b> — версия ${it.version}\nТема: ${esc(it.deliverable.topic)}`,
    `${verdict}. ${esc(c.summary)}\n${CHECK_NAMES.map((k) => `${c.checks[k].ok ? '✓' : '✗'} ${CHECK_LABEL[k]}`).join(' · ')}`,
  ];
  if (!c.passed && c.issues.length) {
    blocks.push(
      [
        'Замечания:',
        ...c.issues.map(
          (i) => `• ${i.variant ? `вар. ${i.variant}: ` : ''}${esc(i.problem)} → ${esc(i.fix)}`,
        ),
      ].join('\n'),
    );
  }
  if (it.ownerComment) blocks.push(`Ваш комментарий учтён: «${esc(it.ownerComment)}»`);
  it.item.variants.forEach((v, i) => {
    blocks.push(
      `<b>Вариант ${i + 1}</b> — <i>${esc(v.angle)}</i>\n<b>${esc(v.hook)}</b>\n\n${esc(v.body)}\n\n${esc(v.cta)}`,
    );
  });
  if (it.item.slides)
    blocks.push(
      ['<b>Слайды:</b>', ...it.item.slides.map((s, i) => `${i + 1}. ${esc(s)}`)].join('\n'),
    );
  if (it.item.reelsScript) {
    blocks.push(
      [
        '<b>Сценарий Reels:</b>',
        ...it.item.reelsScript.map(
          (s) =>
            `<b>${s.fromSec}–${s.toSec} c</b>: ${esc(s.visual)}\n  🎙 ${esc(s.voiceover)}\n  🔤 ${esc(s.onScreenText)}`,
        ),
      ].join('\n'),
    );
  }
  return splitMessage(blocks);
}
