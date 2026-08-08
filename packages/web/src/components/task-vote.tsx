'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '@/lib/api-client';

/** Mirrors TASK_VOTE_MIN/MAX in @haive/shared/fair-priority. Web must not import from
 *  @haive/shared (the barrel drags ioredis -> dns into the bundle), so this is a local copy,
 *  the same way WorkflowType is duplicated in api-client.ts. Only the arrow disabling reads
 *  it; the server clamps authoritatively. */
const VOTE_MIN = -5;
const VOTE_MAX = 5;

const HINT =
  'Vote this task up to run its AI agents sooner when slots are scarce, or down to let ' +
  'others go first. It shifts where the task enters the round-robin — it never starves ' +
  'the rest.';

/**
 * Up/down score control for a task, Stack-Overflow shaped: two arrows and the number.
 *
 * Renders inside the tasks-listing row, which is wrapped in a `<Link>` — hence the
 * preventDefault/stopPropagation on every click, or voting would navigate to the task.
 *
 * The score is owned by the server. A click paints the expected value immediately and the
 * response replaces it; the caller's poll then keeps it fresh. `pending` is tracked so a
 * fast double-click cannot fire two overlapping writes against a stale base.
 */
export function TaskVote({
  taskId,
  score,
  className = '',
}: {
  taskId: string;
  score: number;
  className?: string;
}) {
  const [override, setOverride] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Latest server value, so the optimistic override can be dropped once the poll catches up
  // instead of pinning a stale number forever.
  const serverScore = useRef(score);
  useEffect(() => {
    if (serverScore.current !== score) {
      serverScore.current = score;
      setOverride(null);
    }
  }, [score]);

  const shown = override ?? score;

  async function vote(delta: 1 | -1, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next = Math.min(Math.max(shown + delta, VOTE_MIN), VOTE_MAX);
    if (next === shown) return;
    setBusy(true);
    setOverride(next);
    setError(false);
    try {
      const res = await api.post<{ voteScore: number }>(`/tasks/${taskId}/vote`, { delta });
      serverScore.current = res.voteScore;
      setOverride(res.voteScore);
    } catch {
      setOverride(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const atMax = shown >= VOTE_MAX;
  const atMin = shown <= VOTE_MIN;
  const arrow = 'rounded p-0.5 transition-colors disabled:opacity-30';

  return (
    <div
      className={`flex shrink-0 flex-col items-center leading-none ${className}`}
      title={error ? `Vote failed — try again.\n\n${HINT}` : HINT}
    >
      <button
        type="button"
        aria-label="Vote up"
        disabled={busy || atMax}
        onClick={(e) => void vote(1, e)}
        className={`${arrow} ${atMax ? 'text-neutral-700' : 'text-neutral-500 hover:bg-neutral-800 hover:text-emerald-400'}`}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <span
        className={`font-mono text-xs tabular-nums ${
          error
            ? 'text-red-400'
            : shown > 0
              ? 'text-emerald-400'
              : shown < 0
                ? 'text-neutral-500'
                : 'text-neutral-400'
        }`}
      >
        {shown > 0 ? `+${shown}` : shown}
      </span>
      <button
        type="button"
        aria-label="Vote down"
        disabled={busy || atMin}
        onClick={(e) => void vote(-1, e)}
        className={`${arrow} ${atMin ? 'text-neutral-700' : 'text-neutral-500 hover:bg-neutral-800 hover:text-amber-400'}`}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}
