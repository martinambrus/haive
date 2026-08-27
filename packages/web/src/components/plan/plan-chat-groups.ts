import type { PlanConversation, PlanMessage, TaskStatus } from '@/lib/api-client';

export interface PlanChatGroup {
  /** Null for messages written before a task existed, or whose task row was
   *  deleted — the FK is `on delete set null`, so orphaned turns are real. */
  taskId: string | null;
  status: TaskStatus | null;
  messages: PlanMessage[];
  /** A conversation nobody can add to any more. */
  ended: boolean;
}

/** Statuses a conversation cannot come back from. `paused` is absent on
 *  purpose: the web mirror never reports it (a paused task is still `running`
 *  with `pausedAt` set), and a paused chat is resumable. */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Split a node's transcript into conversations, oldest first.
 *
 * Grouped by task rather than by time: each plan_chat task IS one conversation,
 * and turns from two of them interleaved into a single scroll would read as one
 * exchange that never happened.
 */
export function groupPlanConversations(
  messages: PlanMessage[],
  conversations: PlanConversation[],
): PlanChatGroup[] {
  const statusOf = new Map(conversations.map((c) => [c.taskId, c.status]));
  const groups: PlanChatGroup[] = [];
  const byTask = new Map<string, PlanChatGroup>();

  for (const message of messages) {
    const taskId = message.taskId ?? null;
    // An orphaned turn gets its own group rather than joining the previous one:
    // it is not known to belong to that conversation.
    if (taskId === null) {
      groups.push({ taskId: null, status: null, messages: [message], ended: true });
      continue;
    }
    const existing = byTask.get(taskId);
    if (existing) {
      existing.messages.push(message);
      continue;
    }
    const status = statusOf.get(taskId) ?? null;
    const group: PlanChatGroup = {
      taskId,
      status,
      messages: [message],
      // A task the server said nothing about is treated as ended: offering to
      // continue a conversation that cannot accept a turn is the worse failure.
      ended: status === null || TERMINAL.has(status),
    };
    byTask.set(taskId, group);
    groups.push(group);
  }
  return groups;
}

/** The conversation a new turn belongs to: the newest group still able to take
 *  one. Null when every conversation has ended, which is what makes the next
 *  message start a fresh task. */
export function liveConversation(groups: PlanChatGroup[]): PlanChatGroup | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    if (!group.ended && group.taskId) return group;
  }
  return null;
}
