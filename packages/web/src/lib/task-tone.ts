/**
 * What COLOUR a task reads as in the sidebar's compact list.
 *
 * Deliberately not `statusVariant` from the tasks page: that answers "which badge
 * variant", and a badge sits beside a status WORD that names the state. A tinted row has
 * no such word, so it folds in the two states that are not in `status` at all — a task
 * parked by the user (`pausedAt`) and one parked behind a capacity gate (`slotWait`) both
 * report `status: 'running'` while nothing is running.
 *
 * The precedence is the tasks page's own (`app/(app)/tasks/page.tsx`, the badge block):
 * pausedAt -> slotWait -> status. Keep the two in step.
 */

export type TaskTone = 'failed' | 'waiting' | 'running' | 'idle';

/** Minimal shape — not `Task`, so a test does not have to build an 80-field row. */
export interface TaskToneLike {
  status: string;
  pausedAt?: string | null;
  slotWait?: { kind: string } | null;
}

export function taskTone(task: TaskToneLike): TaskTone {
  if (task.status === 'failed') return 'failed';
  if (task.pausedAt) return 'waiting';
  if (task.slotWait) return 'waiting';
  if (task.status === 'waiting_user' || task.status === 'waiting_pr') return 'waiting';
  if (task.status === 'running') return 'running';
  return 'idle';
}

/** Row background per tone.
 *
 *  A tint, not a fill: the row also carries text and sits in a scrolling list, so the
 *  colour has to read as a state marker without competing with the title. `idle` is
 *  transparent on purpose — "created / queued" is the absence of a state worth colouring,
 *  and giving it a fourth hue would make the three that matter harder to pick out.
 *
 *  The alpha is bounded from BELOW by tone-vs-tone separation, not by whether a tint is
 *  visible against the background — two adjacent rows reading as the same colour destroys
 *  the signal well before either becomes invisible. MEASURED over the aside's neutral-950
 *  (CIELab dE76, JND ~2.3): at a uniform /6 every tint is 5.5-6.4 from the background, but
 *  red-vs-amber — the closest pair, and the only one that matters, since red-vs-emerald is
 *  9.8 — is 5.71, i.e. 2.5 JND. Over threshold on paper and too close in the list.
 *
 *  So amber alone is lifted, rather than every tint: raising the pair together moves both
 *  and leaves the gap ~2.5 JND (13.54 at /12, against 13.68-15.49 to the background). At
 *  amber /10 the gap is 10.31 (4.5 JND) with red and emerald held at /6, and no other pair
 *  regresses — amber-vs-emerald goes 7.34 to 12.42. /4-/5 is the floor either way: red
 *  reaches 3.25 from the background at /4. Hover doubles, keeping the 2x relationship the
 *  original /10-to-/20 had. Title text is unaffected — a tint only darkens the row, so
 *  contrast rises (13.8:1 for neutral-200 over amber /10). */
export const TASK_TONE_CLASS: Record<TaskTone, string> = {
  failed: 'bg-red-500/6 hover:bg-red-500/12',
  waiting: 'bg-amber-500/10 hover:bg-amber-500/20',
  running: 'bg-emerald-500/6 hover:bg-emerald-500/12',
  idle: 'hover:bg-neutral-800/60',
};

/** What the tint means, for the row's `title` — the colour alone is not a label, and it
 *  is the only status signal a row carries. */
export const TASK_TONE_LABEL: Record<TaskTone, string> = {
  failed: 'failed',
  waiting: 'waiting',
  running: 'running',
  idle: 'queued',
};

/** The tones the sidebar offers as filters. `idle` is deliberately absent: it is the
 *  ABSENCE of a state worth colouring, so there is no swatch to put on a button — and a
 *  task nobody has started yet is not something you filter FOR. It shows only when no
 *  filter is on, which the row tints make legible: the untinted rows are the ones the
 *  three buttons cannot select. */
export const TASK_TONE_FILTERS = ['running', 'waiting', 'failed'] as const;

export type TaskToneFilter = (typeof TASK_TONE_FILTERS)[number];

export function isTaskToneFilter(value: unknown): value is TaskToneFilter {
  return typeof value === 'string' && (TASK_TONE_FILTERS as readonly string[]).includes(value);
}

/** Filter button styling, active and inactive.
 *
 *  The TEXT carries the tone in both states and never changes, so the group reads as a
 *  permanent legend for the row tints — with all three off it is still what tells you what
 *  amber means. Only the fill and border carry pressed/unpressed. MEASURED against the
 *  sidebar's neutral-950: 12.99:1 (emerald-300), 13.73:1 (amber-300), 10.43:1 (red-300)
 *  unpressed, and the worst case is red-300 over its own pressed `bg-red-500/20` fill at
 *  8.55:1 — every state clears AAA, which matters at this 10px uppercase size.
 *
 *  Hover therefore moves to the border and a light fill: with the text already coloured
 *  there is nothing left for it to brighten. */
export const TASK_TONE_BUTTON_CLASS: Record<TaskToneFilter, { on: string; off: string }> = {
  running: {
    on: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50',
    off: 'border-neutral-800 text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/10',
  },
  waiting: {
    on: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
    off: 'border-neutral-800 text-amber-300 hover:border-amber-500/40 hover:bg-amber-500/10',
  },
  failed: {
    on: 'bg-red-500/20 text-red-300 border-red-500/50',
    off: 'border-neutral-800 text-red-300 hover:border-red-500/40 hover:bg-red-500/10',
  },
};

/**
 * Keep only the tasks whose tone is selected.
 *
 * An EMPTY selection means no filter, not "match nothing" — the three buttons are toggles
 * and turning the last one off has to return the list to showing everything, which is the
 * only reading under which the group can be switched off at all.
 */
export function filterTasksByTone<T extends TaskToneLike>(
  tasks: T[],
  tones: readonly TaskToneFilter[],
): T[] {
  if (tones.length === 0) return tasks;
  const wanted = new Set<string>(tones);
  return tasks.filter((t) => wanted.has(taskTone(t)));
}
