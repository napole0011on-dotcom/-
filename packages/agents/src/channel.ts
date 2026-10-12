import type { Notifier } from '@cms/providers';
import type { Verdict } from './agents/critic.js';
import type { CeoPlan, CopyItem, Deliverable } from './schemas.js';
import type { PlanEstimate } from './estimate.js';
import type { Pipeline } from './graph.js';
import type { GenericVerdict } from './nodes.js';

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
  /** Steps from the board (agent links) this plan will run, in order. */
  pipeline: Pipeline;
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

/** A result of any other agent of the graph (SEO, Image, ...), shown at gate 2. */
export interface NodeItemView {
  artifactId: string;
  version: number;
  agent: string;
  agentName: string;
  title: string;
  lines: string[];
  critic: GenericVerdict | null;
  criticRejected: boolean;
  ownerComment: string | null;
  /** Files of the result (images): names and mime types; the panel loads them by index. */
  files: { name: string; mimeType: string }[];
}

/** What the owner sees at gate 2 (whole package or only the items that changed). */
export interface PackageView {
  taskId: string;
  title: string;
  items: PackageItemView[];
  nodeItems: NodeItemView[];
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
