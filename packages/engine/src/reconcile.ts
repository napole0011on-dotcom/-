import { PermanentError, type Actor } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';

const { walletSnapshots, costRecords, auditLog } = schema;

export type ReconcileKind = 'baseline' | 'topup' | 'ok' | 'undercount';

export interface ReconcileResult {
  kind: ReconcileKind;
  message: string;
  walletSpentUsd: number | null;
  recordedRawUsd: number;
  recordedBudgetUsd: number;
  /** For undercount: a safety factor that would have covered the real spend (+10%). */
  suggestedFactor: number | null;
}

/** Drift is reported when the wallet lost more than our budgeted records by this much. */
export function driftTolerance(walletSpentUsd: number): number {
  return Math.max(walletSpentUsd * 0.1, 0.1);
}

/** "12,34", "$12.34", "12.3" -> 12.34; null if not a non-negative amount. */
export function parseUsd(text: string): number | null {
  const m = /^\s*\$?\s*(\d+(?:[.,]\d{1,8})?)\s*\$?\s*$/.exec(text);
  return m ? Number(m[1]!.replace(',', '.')) : null;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * Manual wallet reconciliation: the owner types the balance shown in the provider's
 * dashboard. The balance drop since the previous snapshot is compared with what we
 * recorded for that provider. If the provider charged noticeably more than our budgeted
 * records, the owner gets a concrete LLM_COST_SAFETY_FACTOR to set.
 */
export async function reconcileWallet(
  db: DbOrTx,
  input: {
    brandId: string;
    provider: string;
    balanceUsd: number;
    costSafetyFactor: number;
    actor: Actor;
  },
): Promise<ReconcileResult> {
  if (input.actor.kind !== 'human')
    throw new PermanentError('reconcile_requires_human', 'Only a human can reconcile the wallet');
  if (!(input.balanceUsd >= 0))
    throw new PermanentError('invalid_amount', 'Balance must be a non-negative number');

  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select()
      .from(walletSnapshots)
      .where(
        sql`${walletSnapshots.brandId} = ${input.brandId} and ${walletSnapshots.provider} = ${input.provider}`,
      )
      .orderBy(sql`${walletSnapshots.createdAt} desc`)
      .limit(1);

    const [rec] = await tx
      .select({
        raw: sql<string>`coalesce(sum(${costRecords.rawCostUsd}), 0)`,
        budget: sql<string>`coalesce(sum(${costRecords.costUsd}), 0)`,
      })
      .from(costRecords)
      .where(
        sql`${costRecords.brandId} = ${input.brandId} and ${costRecords.provider} = ${input.provider} and ${costRecords.status} = 'final'${
          prev
            ? sql` and ${costRecords.createdAt} > ${prev.createdAt.toISOString()}::timestamptz`
            : sql``
        }`,
      );
    const recordedRawUsd = Number(rec!.raw);
    const recordedBudgetUsd = Number(rec!.budget);

    let result: ReconcileResult;
    if (!prev) {
      result = {
        kind: 'baseline',
        message: `Базовый баланс ${usd(input.balanceUsd)} сохранён (${input.provider}). Следующая сверка покажет, сходится ли учёт.`,
        walletSpentUsd: null,
        recordedRawUsd,
        recordedBudgetUsd,
        suggestedFactor: null,
      };
    } else {
      const spent = Number(prev.balanceUsd) - input.balanceUsd;
      if (spent < 0) {
        result = {
          kind: 'topup',
          message: `Баланс вырос на ${usd(-spent)} — похоже на пополнение. Сверка начнётся заново с ${usd(input.balanceUsd)}.`,
          walletSpentUsd: null,
          recordedRawUsd,
          recordedBudgetUsd,
          suggestedFactor: null,
        };
      } else if (spent > recordedBudgetUsd + driftTolerance(spent)) {
        const factor =
          recordedRawUsd > 0 ? Math.ceil(((spent / recordedRawUsd) * 1.1) / 0.05) * 0.05 : null;
        result = {
          kind: 'undercount',
          message:
            `⚠️ Учёт занижен: кошелёк уменьшился на ${usd(spent)}, а записано ${usd(recordedRawUsd)} ` +
            `(с запасом ×${input.costSafetyFactor}: ${usd(recordedBudgetUsd)}).` +
            (factor
              ? ` Рекомендую LLM_COST_SAFETY_FACTOR=${factor.toFixed(2)} в .env и перезапуск бота.`
              : ' Мы не записали ни одного платного вызова — проверьте цены в файле MODEL_PRICING_FILE.'),
          walletSpentUsd: spent,
          recordedRawUsd,
          recordedBudgetUsd,
          suggestedFactor: factor,
        };
      } else {
        result = {
          kind: 'ok',
          message: `Сходится: кошелёк −${usd(spent)}, записано ${usd(recordedRawUsd)} (с запасом ${usd(recordedBudgetUsd)}).`,
          walletSpentUsd: spent,
          recordedRawUsd,
          recordedBudgetUsd,
          suggestedFactor: null,
        };
      }
    }

    await tx.insert(walletSnapshots).values({
      brandId: input.brandId,
      provider: input.provider,
      balanceUsd: input.balanceUsd.toFixed(8),
      recordedRawUsd: recordedRawUsd.toFixed(8),
      walletSpentUsd: result.walletSpentUsd === null ? null : result.walletSpentUsd.toFixed(8),
      source: 'manual',
      createdBy: input.actor.id,
    });
    await tx.insert(auditLog).values({
      brandId: input.brandId,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: 'wallet_reconciled',
      details: { ...result, provider: input.provider, balanceUsd: input.balanceUsd },
    });
    return result;
  });
}
