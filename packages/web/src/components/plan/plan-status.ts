import type { PlanNodeKind, PlanNodeStatus } from '@/lib/api-client';

/**
 * How a plan node's state is spelled and coloured.
 *
 * One module for every view — the card grid, the tree, the detail panel and the
 * impact graph all read from here — so "green" cannot come to mean three
 * slightly different things depending on which surface you are looking at.
 *
 * The colour is always driven by `rolledStatus`, never by a node's own status:
 * a parent showing green over an unfinished child is the single most misleading
 * thing this UI could do.
 */

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

interface StatusPresentation {
  label: string;
  /** Tailwind background for the small dot on a card. */
  dot: string;
  badge: BadgeVariant;
}

const STATUS: Record<PlanNodeStatus, StatusPresentation> = {
  todo: { label: 'To do', dot: 'bg-neutral-600', badge: 'default' },
  in_progress: { label: 'In progress', dot: 'bg-indigo-400', badge: 'info' },
  // Amber, not red: a human blocker is something waiting on a person, not
  // something that went wrong. Red is reserved for failure so it keeps meaning
  // failure.
  blocked_human: { label: 'Blocked (needs a person)', dot: 'bg-amber-400', badge: 'warning' },
  done: { label: 'Done', dot: 'bg-emerald-400', badge: 'success' },
  // Muted rather than green: written off is not achieved, and colouring it green
  // would inflate how much of the plan looks complete.
  not_applicable: { label: 'Not applicable', dot: 'bg-neutral-700', badge: 'default' },
};

export function statusLabel(status: PlanNodeStatus): string {
  return STATUS[status].label;
}

export function statusDot(status: PlanNodeStatus): string {
  return STATUS[status].dot;
}

export function statusBadge(status: PlanNodeStatus): BadgeVariant {
  return STATUS[status].badge;
}

export const PLAN_STATUSES: PlanNodeStatus[] = [
  'todo',
  'in_progress',
  'blocked_human',
  'done',
  'not_applicable',
];

const KIND: Record<PlanNodeKind, { label: string; hint: string }> = {
  component: { label: 'Component', hint: 'A part of the system' },
  decision: { label: 'Decision', hint: 'A choice to make or record' },
  research: { label: 'Research', hint: 'Needs investigating before it can be decided' },
  external: { label: 'External', hint: 'A non-code blocker: legal, a domain, hosting, an account' },
};

export function kindLabel(kind: PlanNodeKind): string {
  return KIND[kind].label;
}

export function kindHint(kind: PlanNodeKind): string {
  return KIND[kind].hint;
}

/** Kinds the UI OFFERS. `decision` is deliberately absent: it is a label a
 *  build agent may write into plan.md, never something a human needs to pick —
 *  existing decision nodes still resolve through `kindLabel`, they just render
 *  without a kind badge. */
export const PLAN_KINDS: PlanNodeKind[] = ['component', 'research', 'external'];

/** `(direct / total)` as it appears on a card. Both numbers are server-computed;
 *  showing only the total would hide that a node with 3 children has 400
 *  descendants, which is exactly the thing a drill-down needs to convey. */
export function countLabel(directChildren: number, totalDescendants: number): string {
  return `${directChildren} / ${totalDescendants}`;
}

/** Whether a node's displayed state differs from its own recorded one — i.e. the
 *  roll-up changed the answer. The detail panel says so explicitly, because a
 *  user who set a node to `done` and sees amber deserves to know why. */
export function isRolledUp(own: PlanNodeStatus, rolled: PlanNodeStatus): boolean {
  return own !== rolled;
}
