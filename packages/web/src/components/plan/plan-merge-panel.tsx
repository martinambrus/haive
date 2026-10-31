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
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { planOrigin, rememberTaskOrigin } from '@/lib/task-origin';
import { isAwaitingFormInput } from '@/lib/submit-state';
import { isTaskDead } from '@/lib/step-banners';

const POLL_MS = 2000;
const DEAD_POLL_MS = 30_000;

type MergeNotice = { taskId: string; text: string; retry?: boolean };

function mergeOutcome(taskId: string, task: Task): MergeNotice | null {
  if (!['completed', 'cancelled', 'failed'].includes(task.status)) return null;
  return {
    taskId,
    text:
      task.status === 'completed'
        ? 'The remote was merged into your checkout and pushed.'
        : task.status === 'cancelled'
          ? 'This merge was cancelled elsewhere. Its scratch worktree may be discarded unless another merge holds it. This does not undo changes already merged into your checkout.'
          : 'The merge failed. Retry on its task resumes it while its scratch worktree is still there. A Save or Pull may discard it.',
    retry: task.status === 'failed',
  };
}

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
  /** Called when the merge lands or a discard settles (including when nothing was discarded),
   *  so the page can refresh. */
  onSettled: () => void;
}) {
  const [liveStep, setLiveStep] = useState<TaskStep | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MergeNotice | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Refs, not poll dependencies: the page passes both inline and the poll calls them when it
  // settles, so depending on them would re-poll a parked merge on every page render.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  // Bumped after an answer: a settled poll has stopped and the task id is unchanged.
  const [pollRestart, setPollRestart] = useState(0);
  // Discard only queues the cancel, so the step still reads as parked until it lands.
  const [discardedTaskId, setDiscardedTaskId] = useState<string | null>(null);
  const discardRequestedRef = useRef<string | null>(null);
  const [deadTaskId, setDeadTaskId] = useState<string | null>(null);

  // Poll the task only while it is working, and stop the moment it parks or reaches
  // a terminal status — the same self-terminating shape the plan chat uses, so an
  // idle conversation costs nothing.
  const taskId = merge?.taskId ?? null;
  // An answer or discard can settle after the page switches to another conversation.
  const lastTaskIdRef = useRef(taskId);
  const displayedTaskIdRef = useRef(taskId);
  displayedTaskIdRef.current = taskId;
  const isStaleReply = (replyTaskId: string): boolean =>
    displayedTaskIdRef.current !== null && displayedTaskIdRef.current !== replyTaskId;
  const discarding = taskId !== null && discardedTaskId === taskId;
  const dead = taskId !== null && deadTaskId === taskId;
  useEffect(() => {
    setDraft('');
    setError(null);
    setLiveStep(null);
    setBusy(false);
    setDiscardedTaskId(null);
    setDeadTaskId(null);
    // An ended outcome survives the refresh to null, but belongs to no later conversation.
    if (taskId !== null) {
      discardRequestedRef.current = null;
      lastTaskIdRef.current = taskId;
      setNotice(null);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setLiveStep(null);
      const previousTaskId = lastTaskIdRef.current;
      if (
        !previousTaskId ||
        notice?.taskId === previousTaskId ||
        discardRequestedRef.current === previousTaskId
      )
        return;
      // The page may see the end first, or the panel may have stopped at a form.
      // Retry unreadable tasks twice; any answer ends this bounded recovery.
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let attempts = 0;
      const recover = async (): Promise<void> => {
        attempts++;
        try {
          const res = await api.get<{ task: Task }>(`/tasks/${previousTaskId}`);
          if (cancelled || isTaskDead(res.task)) return;
          const outcome = mergeOutcome(previousTaskId, res.task);
          if (outcome) {
            setNotice(outcome);
            onSettledRef.current();
          }
        } catch {
          if (!cancelled && attempts < 3) timer = setTimeout(() => void recover(), POLL_MS);
        }
      };
      void recover();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polledDead = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await api.get<{ task: Task; steps: TaskStep[] }>(`/tasks/${taskId}`);
        if (cancelled) return;
        const step = res.steps.find((s) => s.stepId === PLAN_MERGE_STEP_ID) ?? null;
        const taskDead = isTaskDead(res.task);
        setLiveStep(step);
        setDeadTaskId(taskDead ? taskId : null);
        const ended = ['completed', 'cancelled', 'failed'].includes(res.task.status);
        const settled = !taskDead && ((!discarding && isAwaitingFormInput(step)) || ended);
        if (settled || (taskDead && !polledDead)) onChangedRef.current();
        if (settled) {
          if (ended) {
            if (discardRequestedRef.current !== taskId) {
              setNotice(mergeOutcome(taskId, res.task));
            }
            onSettledRef.current();
          }
          return;
        }
        polledDead = taskDead;
      } catch {
        // A transient read failure retries at the same cadence.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), polledDead ? DEAD_POLL_MS : POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, pollRestart, discarding]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [merge?.messages.length]);

  const parked = !discarding && !dead && isAwaitingFormInput(liveStep);
  const working = merge !== null && !parked && !dead;

  async function answer(decision: 'confirm' | 'revise'): Promise<void> {
    if (!merge) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await submitPlanMergeTurn(merge.taskId, {
        decision,
        ...(decision === 'revise' ? { message: draft.trim() } : {}),
      });
      if (isStaleReply(merge.taskId)) return;
      setDraft('');
      setLiveStep(null);
      setPollRestart((n) => n + 1); // resume polling: the step is running again
      onChanged();
    } catch (e) {
      if (isStaleReply(merge.taskId)) return;
      setError((e as ApiError).message ?? 'Could not send that');
    } finally {
      if (!isStaleReply(merge.taskId)) setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!merge) return;
    if (
      !window.confirm(
        'Discard this merge? Its scratch worktree may be removed. Changes already merged into your checkout will remain.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    discardRequestedRef.current = merge.taskId;
    try {
      const result = await discardPlanMerge(repositoryId, merge.taskId);
      if (!result.cancelled && discardRequestedRef.current === merge.taskId) {
        discardRequestedRef.current = null;
      }
      if (isStaleReply(merge.taskId)) return;
      if (result.cancelled) {
        setDiscardedTaskId(taskId);
      } else {
        setNotice({
          taskId: merge.taskId,
          text: 'The merge is no longer open: it completed, was cancelled or failed. Nothing was discarded.',
        });
      }
      onSettled();
    } catch (e) {
      if (discardRequestedRef.current === merge.taskId) discardRequestedRef.current = null;
      if (isStaleReply(merge.taskId)) return;
      setError((e as ApiError).message ?? 'Could not discard the merge');
    } finally {
      if (!isStaleReply(merge.taskId)) setBusy(false);
    }
  }

  const outcome =
    notice && (merge === null || merge.taskId === notice.taskId) ? (
      <div
        role="status"
        className="rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400"
      >
        <InlineMarkdown body={notice.text} />
        {notice.retry && (
          <Link
            href={`/tasks/${notice.taskId}`}
            onClick={() => rememberTaskOrigin(`/tasks/${notice.taskId}`, planOrigin(repositoryId))}
            className="text-indigo-300 underline"
          >
            Open the task to retry
          </Link>
        )}
      </div>
    ) : null;
  if (!merge) return outcome;

  return (
    <>
      {outcome}
      <div className="flex flex-col gap-2 rounded-md border border-amber-900 bg-amber-950/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-amber-200">
            Resolving the merge with the remote
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || discarding}
            onClick={() => void discard()}
          >
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
          The merge is prepared in a scratch worktree. Confirm merges it into your checkout and
          pushes it. The conversation runs as a task,{' '}
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
    </>
  );
}
