import type { Notifier } from '@cms/providers';
import type { Verdict } from './agents/critic.js';
import type { CeoPlan, CopyItem, Deliverable } from './schemas.js';
import type { PlanEstimate } from './estimate.js';

/** What the owner sees at gate 1. */
export interface PlanView {
  taskId: string;
  title: string;
  planArtifactId: string;
  version: number;
  plan: CeoPlan;
  estimate: PlanEstimate;
  spentUsd: number;
  taskBudgetUsd: number;
}

export interface PackageItemView {
  artifactId: string;
  version: number;
  deliverable: Deliverable;
  item: CopyItem;
  critic: Verdict;
  /** Critic review rounds this version went through (max 3: draft + 2 revisions). */
  criticRound: number;
  /** Critic still disagreed after the maximum number of revisions. */
  criticRejected: boolean;
  ownerComment: string | null;
}

/** What the owner sees at gate 2 (whole package or only the items that changed). */
export interface PackageView {
  taskId: string;
  title: string;
  items: PackageItemView[];
  /** Items of the package still waiting for a decision (including the ones shown). */
  pendingCount: number;
  totalCount: number;
  spentUsd: number;
  taskBudgetUsd: number;
  isUpdate: boolean;
}

export interface ExportView {
  taskId: string;
  title: string;
  dir: string;
  files: { name: string; content: Buffer }[];
  spentUsd: number;
}

/** The owner's interface (Telegram in production, a recorder in tests). */
export interface OwnerChannel extends Notifier {
  sendPlan(v: PlanView): Promise<void>;
  sendPackage(v: PackageView): Promise<void>;
  sendExport(v: ExportView): Promise<void>;
}
