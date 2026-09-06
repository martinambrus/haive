import type { PlanTaskProposal } from '@haive/shared';
import type { PlanMessage } from '@/lib/api-client';

/** How many plan operations a turn actually sent, for the count rendered
 *  beside it. Null when the turn carried no patch at all (a prose reply).
 *
 *  Shown because prose is not evidence: an agent has reported "Done — three
 *  children now hang off this node" while sending `ops: []`, and the only thing
 *  that touched the plan was the ops. The count is the record.
 *
 *  A patch whose `ops` is not an array reads as null rather than 0: "this turn
 *  carried no operations" and "this turn's patch is a shape nobody recognises"
 *  are different statements, and rendering the second as `plan unchanged` would
 *  be the same false reassurance the badge exists to end. */
export function opCount(patch: unknown): number | null {
  if (!patch || typeof patch !== 'object') return null;
  const ops = (patch as { ops?: unknown }).ops;
  return Array.isArray(ops) ? ops.length : null;
}

/**
 * The task offer a turn carried, or null.
 *
 * Read out of the stored patch the same way `opCount` reads the op list, rather
 * than typing `PlanMessage.patch`: that field is deliberately `unknown` on the
 * client because it is whatever an agent wrote, and one narrow reader per thing
 * the UI actually renders is what keeps a malformed turn from breaking the
 * transcript around it.
 */
export function taskProposal(patch: unknown): PlanTaskProposal | null {
  if (!patch || typeof patch !== 'object') return null;
  const raw = (patch as { taskProposal?: unknown }).taskProposal;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<PlanTaskProposal>;
  if (!Array.isArray(p.nodeRefs) || p.nodeRefs.length === 0) return null;
  if (typeof p.title !== 'string' || p.title === '') return null;
  if (p.role !== 'implements' && p.role !== 'touched') return null;
  return {
    nodeRefs: p.nodeRefs.filter((id): id is string => typeof id === 'string'),
    title: p.title,
    description: typeof p.description === 'string' ? p.description : '',
    role: p.role,
    reason: typeof p.reason === 'string' ? p.reason : '',
  };
}

/** A timestamp in the viewer's own locale and zone. Undefined or unparseable
 *  reads as null so a caller can leave the label off entirely rather than print
 *  "Invalid Date" beside a real message. */
export function stamp(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** When a conversation started, from its first turn — the API records the
 *  opening message as the task is created, so this IS the task's start. */
export function startedLabel(iso: string | undefined): string {
  return stamp(iso) ?? 'Conversation';
}

/**
 * The first reply the user has not seen, or null when everything is read.
 *
 * Counted BACKWARDS from the newest turn rather than compared against a read
 * timestamp: the count is what the server computed at the moment the tab
 * opened, and opening the tab marks the node read, so a timestamp comparison
 * would find nothing unread a beat later and the divider would vanish the
 * instant it appeared.
 *
 * Only assistant turns count. The user has by definition read what they typed,
 * and including their turns would push the divider above a reply they had
 * already seen.
 *
 * A count larger than the transcript holds — a node whose older turns were
 * trimmed, or a stale count — puts the divider on the oldest reply rather than
 * dropping it: "everything here is new" is the honest reading of a count that
 * outruns the messages.
 */
export function firstUnreadMessageId(messages: PlanMessage[], unreadAtOpen: number): string | null {
  if (unreadAtOpen <= 0) return null;
  let firstUnreadId: string | null = null;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    seen += 1;
    firstUnreadId = m.id;
    if (seen === unreadAtOpen) break;
  }
  return firstUnreadId;
}
