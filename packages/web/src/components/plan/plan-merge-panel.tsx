'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PLAN_MERGE_STEP_ID,
  api,
  discardPlanMerge,
  submitPlanMergeTurn,
  type ApiError,
  type PlanMergeState,
  type Task,
  type TaskStep,
} from '@/lib/api-client';
import { Button, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { planOrigin, rememberTaskOrigin } from '@/lib/task-origin';

const POLL_MS = 2000;

/**
 * The merge conversation, answered here rather than on the task page.
 *
 * Same transport as the plan chat: a `plan_merge` task parks on its step form after
 * every turn, and that form is how both the follow-up and the confirmation travel.
 * The task page is where such a form is normally answered, so this panel answers it
 * instead and the user never leaves the plan.
 *
 * Deliberately NOT built by extracting a shared component out of `plan-chat.tsx`:
 * that chat ends on a blank submit while this one ends on an explicit confirm, so the
 * composer differs in the part that matters. Refactoring a working conversation to
 * serve a second caller with a different ending is how both end up wrong; the pure
 * helpers are shared instead.
 */
export function PlanMergePanel({
  repositoryId,
  merge,
  onChanged,
  onSettled,
}: {
  repositoryId: string;
  /** Polled by the page, which already watches this to gate Save and Pull. Passed
   *  in rather than fetched again here: two pollers for one fact drift, and the
   *  first version of this panel fetched only on MOUNT, so a merge that started
   *  afterwards never appeared at all. */
  merge: PlanMergeState | null;
  /** Re-read the merge (new turns in the transcript). */
  onChanged: () => void;
  /** Called when the merge lands or is discarded, so the page can refresh. */
  onSettled: () => void;
}) {
  const [liveStep, setLiveStep] = useState<TaskStep | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Poll the task only while it is working, and stop the moment it parks or reaches
  // a terminal status — the same self-terminating shape the plan chat uses, so an
  // idle conversation costs nothing.
  const taskId = merge?.taskId ?? null;
  useEffect(() => {
    if (!taskId) {
      setLiveStep(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const res = await api.get<{ task: Task; steps: TaskStep[] }>(`/tasks/${taskId}`);
        if (cancelled) return;
        const step = res.steps.find((s) => s.stepId === PLAN_MERGE_STEP_ID) ?? null;
        setLiveStep(step);
        const settled =
          step?.status === 'waiting_form' ||
          ['completed', 'cancelled', 'failed'].includes(res.task.status);
        if (settled) {
          onChanged();
          if (['completed', 'cancelled', 'failed'].includes(res.task.status)) onSettled();
          return;
        }
      } catch {
        return;
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, onChanged, onSettled]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [merge?.messages.length]);

  const parked = liveStep?.status === 'waiting_form';
  const working = merge !== null && !parked;

  async function answer(decision: 'confirm' | 'revise'): Promise<void> {
    if (!merge) return;
    setBusy(true);
    setError(null);
    try {
      await submitPlanMergeTurn(merge.taskId, {
        decision,
        ...(decision === 'revise' ? { message: draft.trim() } : {}),
      });
      setDraft('');
      setLiveStep(null); // resume polling: the step is running again
      onChanged();
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not send that');
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!window.confirm('Discard this merge? Your checkout has not moved, so nothing is lost.'))
      return;
    setBusy(true);
    setError(null);
    try {
      await discardPlanMerge(repositoryId);
      onSettled();
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not discard the merge');
    } finally {
      setBusy(false);
    }
  }

  if (!merge) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-900 bg-amber-950/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-amber-200">Resolving the merge with the remote</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>
          Discard
        </Button>
      </div>

      {merge.messages.length > 0 && (
        <div
          style={{ height: '16rem' }}
          className="min-h-24 resize-y overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-2"
        >
          {merge.messages.map((m) => (
            <div key={m.id} className="mb-2">
              <p className="text-[11px] uppercase tracking-wide text-indigo-300">
                {m.role === 'user' ? 'You' : 'Agent'}
              </p>
              <MarkdownView body={m.body} className="max-h-none overflow-visible px-0 py-1" />
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {working && (
        <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {liveStep?.statusMessage ?? 'Resolving…'}
        </div>
      )}

      {parked && (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Optional — say what to do differently, then press Change something"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 disabled:opacity-50"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void answer('confirm')}>
              {busy ? 'Working…' : 'Confirm — merge in and push'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !draft.trim()}
              onClick={() => void answer('revise')}
            >
              Change something
            </Button>
          </div>
        </>
      )}

      <FormError message={error} />
      <p className="text-[11px] text-neutral-500">
        Your checkout has not moved — the merge is in a scratch worktree until you confirm. The
        conversation runs as a task,{' '}
        <Link
          href={`/tasks/${merge.taskId}`}
          onClick={() => rememberTaskOrigin(`/tasks/${merge.taskId}`, planOrigin(repositoryId))}
          className="text-indigo-300 underline"
        >
          open it
        </Link>{' '}
        to watch the agent work.
      </p>
    </div>
  );
}
