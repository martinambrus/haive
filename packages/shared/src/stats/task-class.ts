/**
 * Task class — the axis statistics group by.
 *
 * `tasks.type` alone is a poor axis. It has twelve members that mean four different KINDS of
 * thing, and a `workflow` task splits further by `execution_path` into paths whose cost
 * differs by an order of magnitude. Grouping a chart by the raw enum produces twelve thin
 * series nobody can read, and hides that "setup" work is overhead rather than delivery.
 *
 * Derived, deliberately not a stored column: it is a presentation grouping over facts the
 * rows already carry, so it can change without a migration and cannot drift from `type`.
 *
 * ROLLBACK IS NOT A TYPE. An onboarding rollback is an `onboarding_upgrade` task carrying
 * `metadata.mode === 'rollback'` (see the create path in api/routes/upgrades.ts). That key is
 * a real contract — the same code writes and reads it — but it is a jsonb key, not an enum
 * member, so it has to be read explicitly here rather than assumed from the type.
 */

export type TaskClass = 'work' | 'plan' | 'setup' | 'run' | 'other';

export const TASK_CLASS_LABELS: Record<TaskClass, string> = {
  work: 'Work',
  plan: 'Plan',
  setup: 'Setup',
  run: 'Run',
  other: 'Other',
};

/** Every `workflow_type` enum member, mapped. Kept as an explicit table rather than a prefix
 *  test on `plan_`: a prefix rule silently absorbs a future `plan_*` type that might not be
 *  plan work at all, and `advisory` — which IS plan work — has no such prefix. */
const CLASS_BY_TYPE: Record<string, TaskClass> = {
  workflow: 'work',

  plan_build: 'plan',
  plan_chat: 'plan',
  plan_sequence: 'plan',
  plan_merge: 'plan',
  // Researches a non-code blocker on a plan node and parks on a decision form. Plan work
  // despite the name carrying no prefix.
  advisory: 'plan',

  onboarding: 'setup',
  onboarding_upgrade: 'setup',
  kb_author: 'setup',
  // Deprecated as a user-facing type (it runs as a prelude now), but rows still exist.
  env_replicate: 'setup',

  run_app: 'run',
};

export interface TaskClassInput {
  type: string | null | undefined;
  metadata?: Record<string, unknown> | null;
  executionPath?: string | null;
}

export interface TaskClassResult {
  taskClass: TaskClass;
  label: string;
  /** True only for an onboarding upgrade running in rollback mode. */
  isRollback: boolean;
  /** A sub-label inside the class: the execution path for Work, rollback/upgrade for Setup.
   *  null when the class has no meaningful subdivision or the row does not say. */
  subClass: string | null;
}

/** Classify one task.
 *
 *  An unrecognised type resolves to `other`, never to one of the four. A new task type is far
 *  more likely than a corrupt row, and folding it into `work` would inflate the delivery
 *  figures while folding it into `setup` would inflate overhead — both silently. `other`
 *  shows up as its own series and asks to be classified. */
export function resolveTaskClass(input: TaskClassInput): TaskClassResult {
  const type = typeof input.type === 'string' ? input.type : '';
  const taskClass = CLASS_BY_TYPE[type] ?? 'other';
  const isRollback = type === 'onboarding_upgrade' && input.metadata?.['mode'] === 'rollback';

  let subClass: string | null = null;
  if (taskClass === 'work') {
    subClass =
      typeof input.executionPath === 'string' && input.executionPath ? input.executionPath : null;
  } else if (type === 'onboarding_upgrade') {
    subClass = isRollback ? 'rollback' : 'upgrade';
  }

  return { taskClass, label: TASK_CLASS_LABELS[taskClass], isRollback, subClass };
}

/** The classes a UI should offer as filters, in display order. */
export const TASK_CLASSES: TaskClass[] = ['work', 'plan', 'setup', 'run', 'other'];

export function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as string[]).includes(value);
}

/** The `tasks.type` values belonging to a class, for pushing the filter into SQL rather than
 *  classifying every row in memory. `other` has no fixed member list by construction — it is
 *  whatever the table does NOT name — so it returns null and the caller must express it as a
 *  NOT IN over every known type. */
export function typesForClass(taskClass: TaskClass): string[] | null {
  if (taskClass === 'other') return null;
  return Object.entries(CLASS_BY_TYPE)
    .filter(([, c]) => c === taskClass)
    .map(([t]) => t);
}

/** Every type the table knows, so a caller can build the `other` predicate. */
export function knownTaskTypes(): string[] {
  return Object.keys(CLASS_BY_TYPE);
}
