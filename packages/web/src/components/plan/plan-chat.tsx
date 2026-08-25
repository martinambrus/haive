'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getPlanMessages, startPlanChat, type PlanMessage } from '@/lib/api-client';
import { Button, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

/**
 * The per-node conversation.
 *
 * The transcript is read from `plan_node_messages`, not from the step row: a
 * plan_chat step re-targets itself with a reviseLoop and so resets its own row
 * every cycle, which would take the history with it.
 *
 * Sending starts (or continues) a plan_chat task. Continuing an already-parked
 * conversation goes through the step's own form via the task page — this panel
 * links there rather than duplicating the submit transport.
 */
export function PlanChat({
  repositoryId,
  nodeId,
  onPatched,
}: {
  repositoryId: string;
  nodeId: string;
  /** Called after a turn is sent so the canvas can refetch — a chat rooted here
   *  is allowed to patch anywhere in the plan. */
  onPatched: () => void;
}) {
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setActiveTaskId(null);
    void getPlanMessages(repositoryId, nodeId)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        setActiveTaskId(res.messages.at(-1)?.taskId ?? null);
      })
      .catch(() => {
        /* an empty transcript is the normal case, not an error worth showing */
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId, nodeId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setSending(true);
    setError(null);
    try {
      const { taskId } = await startPlanChat(repositoryId, nodeId, { message });
      setDraft('');
      setActiveTaskId(taskId);
      const res = await getPlanMessages(repositoryId, nodeId);
      setMessages(res.messages);
      onPatched();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 p-2">
        {messages.length === 0 ? (
          <p className="px-1 py-2 text-xs text-neutral-500">
            Ask for a change to this part of the plan. The agent is given the WHOLE plan, so it can
            also patch nodes elsewhere when your request touches them.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="mb-2">
              <p className="text-[11px] uppercase tracking-wide text-neutral-600">
                {m.role === 'user' ? 'You' : 'Agent'}
              </p>
              <MarkdownView body={m.body} />
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {activeTaskId && (
        <p className="text-[11px] text-neutral-500">
          The conversation runs as a task —{' '}
          <Link href={`/tasks/${activeTaskId}`} className="text-indigo-300 underline">
            open it
          </Link>{' '}
          to answer follow-ups or end the conversation.
        </p>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="e.g. split Auth into signup and login, and note that the mobile app depends on both"
        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
      />
      <FormError message={error} />
      <Button size="sm" onClick={() => void send()} disabled={sending || !draft.trim()}>
        {sending ? 'Sending…' : 'Send'}
      </Button>
    </div>
  );
}
