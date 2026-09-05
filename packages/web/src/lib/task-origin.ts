/**
 * Where a task view was opened FROM, for its back link.
 *
 * Kept in module memory ON PURPOSE. A task opened in a NEW TAB gets a fresh
 * module and therefore the plain "Back to tasks" fallback — which is the right
 * answer, because the tab that opened it still has the plan on screen. Neither
 * persistent option gets that case right: a query parameter travels with the
 * ctrl-click and would claim the plan in the new tab too, and sessionStorage is
 * COPIED into a link-opened tab by the browser. The cost is that a reload falls
 * back as well; that is honest, since nothing else in the tab knows either.
 *
 * The browser's own Back button was never the broken half — it is real history
 * and already returns to the plan. This is for the in-app back link only.
 */
export interface TaskOrigin {
  /** Where the back link goes, query included (the plan's `?node=`, the list's filters). */
  href: string;
  /** What the back link says, and its aria-label in the fixed title strip. */
  label: string;
}

/** Enough for a session's worth of back-and-forth. The oldest entry is dropped
 *  rather than letting a long-lived tab accumulate one per task it ever opened. */
const LIMIT = 20;

const origins = new Map<string, TaskOrigin>();

/** Keyed on the path alone, so a caller can pass the same href it renders. */
function key(target: string): string {
  const cut = target.search(/[?#]/);
  return cut === -1 ? target : target.slice(0, cut);
}

/** Record where a click into `target` comes from. Called on the LINK, not on the
 *  destination: only the source knows which node was open or which filter was set. */
export function rememberTaskOrigin(target: string, origin: TaskOrigin): void {
  const k = key(target);
  origins.delete(k);
  origins.set(k, origin);
  for (const stale of origins.keys()) {
    if (origins.size <= LIMIT) break;
    origins.delete(stale);
  }
}

/** The origin recorded for this path, or null. NOT consumed — the page reads it on
 *  every render, and the next click into the same path overwrites it, which is what
 *  keeps a later visit from the list from inheriting an earlier visit's plan node. */
export function taskOrigin(target: string): TaskOrigin | null {
  return origins.get(key(target)) ?? null;
}

/** The plan, at the node that was open. Built here rather than passed down as a
 *  prop because half the writers are panels several levels below the plan page. */
export function planOrigin(repositoryId: string, nodeId?: string | null): TaskOrigin {
  return {
    href: `/repos/${repositoryId}/plan${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`,
    label: 'Back to plan',
  };
}

/** Another task, named so the link says which one. Titles run to 512 chars. */
export function taskTitleOrigin(taskId: string, title: string): TaskOrigin {
  const trimmed = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  return { href: `/tasks/${taskId}`, label: `Back to “${trimmed}”` };
}
