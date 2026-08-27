'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import {
  api,
  endPlanChat,
  getPlanMessages,
  markPlanNodeRead,
  setPlanChatProvider,
  startPlanChat,
  submitPlanChatTurn,
  PLAN_CHAT_STEP_ID,
  type CliProvider,
  type PlanConversation,
  type PlanMessage,
  type TaskStep,
  type Task,
} from '@/lib/api-client';
import { Button, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { groupPlanConversations, liveConversation, type PlanChatGroup } from './plan-chat-groups';

/**
 * The per-node conversation, driven entirely from this panel.
 *
 * A plan_chat task parks on a step form after every turn, and that form is the
 * transport: the follow-up message and the "no more turns" signal both go
 * through it. The task page is where that form is normally answered, so this
 * panel answers it instead — nobody should have to leave the plan to reply to a
 * conversation about the plan.
 *
 * The step records the follow-up turn itself, so a continuing message is ONLY
 * submitted to the step. Posting to the chat endpoint as well would write the
 * turn twice and start a second conversation.
 *
 * The transcript lives in `plan_node_messages`, not in the step row, because the
 * revise loop resets that row on every cycle and would take the history with it.
 */

/** How often the live task is re-read while it is working. Matches the task
 *  page's own cadence; polling stops the moment the step parks or the task
 *  ends, so a settled conversation costs nothing. */
const POLL_MS = 2000;

/** How a conversation that can no longer take a turn ENDED. A plain completion
 *  needs no word — the date says everything — but a cancelled or failed one is
 *  a different fact about the same transcript and has to say so. */
const OUTCOME_NOTE: Record<string, string> = {
  cancelled: 'cancelled',
  failed: 'failed',
};

/** When a conversation started, from its first turn — the API records the
 *  opening message as the task is created, so this IS the task's start. */
function startedLabel(iso: string | undefined): string {
  if (!iso) return 'Conversation';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Conversation';
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PlanChat({
  repositoryId,
  nodeId,
  onPatched,
  onRead,
  unreadCount = 0,
}: {
  repositoryId: string;
  nodeId: string;
  /** Called after a turn lands so the canvas can refetch — a chat rooted here
   *  is allowed to patch anywhere in the plan. */
  onPatched: () => void;
  /** Called once this node's transcript has been marked read, so the badges
   *  elsewhere can clear. */
  onRead?: () => void;
  /** Unread replies on this node at the moment it was opened — where the
   *  "new" divider goes. */
  unreadCount?: number;
}) {
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [conversations, setConversations] = useState<PlanConversation[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<CliProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [liveStep, setLiveStep] = useState<TaskStep | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // How many replies were unread when this node was opened, captured ONCE:
  // opening the tab marks them read, so a live count would move the divider
  // past the very replies it is meant to sit above. Counted rather than
  // timestamped because the count is already on screen as the badge.
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Held in a ref, not a dependency: the page recreates this callback on every
  // render, and depending on its identity made the mark-read effect re-run on
  // its own result — a PUT/refetch loop that hammered the API.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  // The (node, turn-count) pair this transcript was last marked read at, so a
  // re-render cannot re-send the same read.
  const markedRef = useRef<string | null>(null);

  const reloadMessages = useCallback(async (): Promise<void> => {
    const res = await getPlanMessages(repositoryId, nodeId);
    setMessages(res.messages);
    setConversations(res.conversations);
  }, [repositoryId, nodeId]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setConversations([]);
    setLiveStep(null);
    setShowHistory(false);
    markedRef.current = null;
    setUnreadAtOpen(unreadCount);
    setError(null);
    void reloadMessages().catch(() => {
      /* an empty transcript is the normal case, not an error worth showing */
    });
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [reloadMessages]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((res) => {
        if (cancelled) return;
        const enabled = res.providers.filter((p) => p.enabled);
        setProviders(enabled);
      })
      .catch(() => {
        /* the picker is optional — without it the server picks the provider */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The first reply the user has not seen: walk back over assistant turns until
  // as many have been passed as were unread when the tab opened.
  let firstUnreadId: string | null = null;
  if (unreadAtOpen > 0) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== 'assistant') continue;
      seen += 1;
      firstUnreadId = m.id;
      if (seen === unreadAtOpen) break;
    }
  }

  const groups = groupPlanConversations(messages, conversations);
  const live = liveConversation(groups);
  const liveTaskId = live?.taskId ?? null;
  // Parked means the step is holding the form open for the next turn — the one
  // state in which this panel can send anything to an existing conversation.
  const parked = liveStep?.status === 'waiting_form';
  const working = liveTaskId !== null && !parked;

  // Poll only while the live task is actually doing something. The step landing
  // on its form (or the task ending) is the signal to refetch and stop.
  useEffect(() => {
    if (!liveTaskId) {
      setLiveStep(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const res = await api.get<{ task: Task; steps: TaskStep[] }>(`/tasks/${liveTaskId}`);
        if (cancelled) return;
        const step = res.steps.find((s) => s.stepId === PLAN_CHAT_STEP_ID) ?? null;
        setLiveStep(step);
        const settled =
          step?.status === 'waiting_form' ||
          ['completed', 'cancelled', 'failed'].includes(res.task.status);
        if (settled) {
          await reloadMessages();
          if (!cancelled) onPatched();
          return;
        }
      } catch {
        // A task that cannot be read is not a reason to spin; the next user
        // action re-reads everything anyway.
        return;
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [liveTaskId, reloadMessages, onPatched]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // Opening the tab is what counts as reading. Not scroll position: a short
  // conversation never scrolls, so waiting for that would leave the badge on
  // forever. The stamp taken BEFORE the write is what the divider uses.
  useEffect(() => {
    if (messages.length === 0) return;
    const key = `${nodeId}:${messages.length}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    let cancelled = false;
    void markPlanNodeRead(repositoryId, nodeId)
      .then(() => {
        if (cancelled) return;
        onReadRef.current?.();
      })
      .catch(() => {
        /* a read marker that fails to save is not worth interrupting a chat */
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the node and on how many turns exist, so a reply arriving while
    // the tab is open is marked read too — but only once per turn count.
  }, [repositoryId, nodeId, messages.length]);

  async function send(): Promise<void> {
    const message = draft.trim();
    if (!message) return;
    setSending(true);
    setError(null);
    try {
      if (liveTaskId && parked) {
        // The STEP writes this turn into the transcript. Sending it here as
        // well would duplicate it and fork a second conversation.
        await submitPlanChatTurn(liveTaskId, message);
      } else {
        await startPlanChat(repositoryId, nodeId, {
          message,
          ...(providerId ? { cliProviderId: providerId } : {}),
        });
      }
      setDraft('');
      await reloadMessages();
      onPatched();
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Failed to send';
      // 409 from the submit route means the step is no longer holding a form —
      // the conversation ended under us. Re-read so the next attempt starts a
      // fresh one instead of retrying into the same wall.
      if (/awaiting form submission/i.test(text)) {
        await reloadMessages().catch(() => {});
        setError('That conversation has ended. Send again to start a new one.');
      } else {
        setError(text);
      }
    } finally {
      setSending(false);
    }
  }

  async function finish(): Promise<void> {
    if (!liveTaskId) return;
    setSending(true);
    setError(null);
    try {
      await endPlanChat(liveTaskId);
      await reloadMessages();
      onPatched();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end the conversation');
    } finally {
      setSending(false);
    }
  }

  async function changeProvider(id: string): Promise<void> {
    setProviderId(id);
    if (!liveTaskId || !id) return;
    try {
      await setPlanChatProvider(liveTaskId, id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change the CLI');
    }
  }

  const history = groups.filter((g) => g !== live);
  const current = live ?? (groups.length > 0 ? groups[groups.length - 1]! : null);
  const older = current ? history.filter((g) => g !== current) : history;

  return (
    <div className="flex flex-col gap-2">
      {messages.length === 0 && (
        // Guidance, not an empty transcript. Inside the bordered box it wore the
        // same frame as the composer below it and read as a message someone had
        // already sent.
        <div className="flex gap-2 rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            Ask for a change to this part of the plan. The agent is given the WHOLE plan, so it can
            also patch nodes elsewhere when your request touches them.
          </p>
        </div>
      )}

      {showHistory &&
        older.map((g, i) => (
          <ConversationGroup key={g.taskId ?? `orphan-${i}`} group={g} defaultOpen={false} />
        ))}

      {/* Only a LIVE conversation opens by itself. A finished one is history:
          it opens when asked for, like every other group. */}
      {current && (
        <ConversationGroup
          group={current}
          defaultOpen={Boolean(live)}
          firstUnreadId={firstUnreadId}
        />
      )}

      {/* Under the groups, where it reads as "there is more below this" rather
          than as a heading for what follows. */}
      {older.length > 0 && (
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="self-start text-xs text-indigo-300 underline"
        >
          {showHistory ? 'Collapse history' : `Show more history (${older.length})`}
        </button>
      )}

      {working && (
        <p className="flex items-center gap-2 text-[11px] text-neutral-400">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {liveStep?.statusMessage ?? 'Thinking…'}
        </p>
      )}

      {liveTaskId && (
        <p className="text-[11px] text-neutral-500">
          The conversation runs as a task —{' '}
          <Link href={`/tasks/${liveTaskId}`} className="text-indigo-300 underline">
            open it
          </Link>{' '}
          to watch what the agent is doing.
        </p>
      )}

      {providers.length > 0 && (
        <label className="flex items-center gap-2 text-[11px] text-neutral-400">
          CLI
          <select
            value={providerId}
            disabled={working}
            onChange={(e) => void changeProvider(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100 disabled:opacity-50"
          >
            <option value="">Default for this repository</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        disabled={working}
        placeholder="e.g. split Auth into signup and login, and note that the mobile app depends on both"
        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 disabled:opacity-50"
      />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={sending || working || !draft.trim()}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {parked && (
          <Button size="sm" variant="secondary" disabled={sending} onClick={() => void finish()}>
            End conversation
          </Button>
        )}
      </div>
      <div ref={endRef} />
    </div>
  );
}

/** One conversation, foldable. Ended ones say so in the header — a dead
 *  conversation that looks live invites a reply nothing will read. */
function ConversationGroup({
  group,
  defaultOpen,
  firstUnreadId,
}: {
  group: PlanChatGroup;
  defaultOpen: boolean;
  firstUnreadId?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A live conversation is named by what it is; a finished one by WHEN it
  // happened, since that is what tells two of them apart in a list.
  const note = OUTCOME_NOTE[group.status ?? ''];
  const label = group.ended
    ? `${startedLabel(group.messages[0]?.createdAt)}${note ? ` (${note})` : ''}`
    : 'Current conversation';
  return (
    <div className="rounded-md border border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
        )}
        <span className="text-xs font-semibold text-neutral-100">{label}</span>
        <span className="ml-auto text-[11px] text-neutral-500">{group.messages.length}</span>
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-neutral-800 p-2">
          {group.messages.map((m) => (
            <div key={m.id} className="mb-2">
              {m.id === firstUnreadId && (
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-px flex-1 bg-indigo-500/40" />
                  <span className="text-[10px] uppercase tracking-wide text-indigo-300">New</span>
                  <span className="h-px flex-1 bg-indigo-500/40" />
                </div>
              )}
              <p className="text-[11px] uppercase tracking-wide text-neutral-600">
                {m.role === 'user' ? 'You' : 'Agent'}
              </p>
              <MarkdownView body={m.body} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
