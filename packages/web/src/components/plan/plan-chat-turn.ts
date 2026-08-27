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
