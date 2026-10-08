/**
 * Task lifecycle. This table is the single source of truth for allowed transitions;
 * the DB layer (engine/transitions.ts) refuses anything not listed here.
 *
 *   draft -> planned -> awaiting_plan_approval -> in_progress -> in_review <-> revision
 *         -> awaiting_final_approval -> approved -> exported -> published
 *                                    -> rejected
 *   any non-terminal -> failed | cancelled
 *
 * Pausing (budget, waiting too long) is NOT a status: it is a flag on the task, so the
 * task resumes exactly where it was.
 */

export const TASK_STATUSES = [
  'draft',
  'planned',
  'awaiting_plan_approval',
  'in_progress',
  'in_review',
  'revision',
  'awaiting_final_approval',
  'approved',
  'rejected',
  'exported',
  'published',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ActorKind = 'human' | 'agent' | 'system';

export interface Actor {
  kind: ActorKind;
  /** e.g. telegram user id, agent name, "scheduler". */
  id: string;
}

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['planned', 'failed', 'cancelled'],
  planned: ['awaiting_plan_approval', 'failed', 'cancelled'],
  // Approve -> in_progress; "change the plan" -> planned (CEO re-plans).
  awaiting_plan_approval: ['in_progress', 'planned', 'cancelled'],
  in_progress: ['in_review', 'failed', 'cancelled'],
  in_review: ['revision', 'awaiting_final_approval', 'failed', 'cancelled'],
  revision: ['in_review', 'failed', 'cancelled'],
  // Approve / reject / "edit with comment" (-> revision).
  awaiting_final_approval: ['approved', 'rejected', 'revision', 'cancelled'],
  // Undo of an approval is allowed while nothing is published.
  approved: ['exported', 'published', 'awaiting_final_approval', 'failed'],
  rejected: ['awaiting_final_approval', 'cancelled'],
  exported: ['published', 'awaiting_final_approval'],
  published: [],
  // A failed task can be retried by a human.
  failed: ['in_progress', 'cancelled'],
  cancelled: [],
};

/**
 * Transitions that represent a human decision at an approval gate. They can never be
 * made by an agent or by the system (no "approved by timeout").
 */
const HUMAN_ONLY: ReadonlySet<string> = new Set([
  'awaiting_plan_approval->in_progress',
  'awaiting_plan_approval->planned',
  'awaiting_final_approval->approved',
  'awaiting_final_approval->rejected',
  'awaiting_final_approval->revision',
  'approved->awaiting_final_approval',
  'rejected->awaiting_final_approval',
  'exported->awaiting_final_approval',
  'approved->published',
  'exported->published',
  'failed->in_progress',
]);

export function isTerminal(status: TaskStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

/** Returns null when allowed, otherwise a human-readable reason. */
export function checkTransition(from: TaskStatus, to: TaskStatus, actor: Actor): string | null {
  if (!TRANSITIONS[from].includes(to)) return `not in the allowed list for ${from}`;
  if (HUMAN_ONLY.has(`${from}->${to}`) && actor.kind !== 'human') {
    return `requires a human decision (actor is ${actor.kind})`;
  }
  return null;
}
