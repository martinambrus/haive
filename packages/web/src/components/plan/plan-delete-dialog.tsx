'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Dialog, DialogContent, DialogHeader } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
import { deletePlan, type ApiError, type OpenPlanTask } from '@/lib/api-client';
import { planDeleteConfirmed } from './plan-delete-confirm';

/**
 * Type-the-name confirmation for deleting a whole plan.
 *
 * The weight of this action lives here rather than in a red button on the page:
 * a control someone brushes past should not be the last thing between them and
 * a 226-node plan. What the dialog owes the reader is an accurate inventory —
 * what goes, what stays, and whether there is a way back — because "are you
 * sure?" asks a question the reader has no way to answer.
 */
export function PlanDeleteDialog({
  open,
  onOpenChange,
  repositoryId,
  repoName,
  nodeCount,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: string;
  repoName: string;
  nodeCount: number;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<OpenPlanTask[]>([]);

  // Every open starts from nothing: a half-typed name or a stale refusal left
  // over from the last attempt would both be answers to a question that is no
  // longer the one on screen.
  useEffect(() => {
    if (!open) return;
    setTyped('');
    setError(null);
    setBlockedBy([]);
  }, [open]);

  const armed = planDeleteConfirmed(typed, repoName) && !busy;

  async function submit(): Promise<void> {
    if (!armed) return;
    setBusy(true);
    setError(null);
    setBlockedBy([]);
    try {
      const res = await deletePlan(repositoryId, typed.trim());
      if (!res.mirrorRemoved) {
        // Not a failure of the delete — the plan is gone — but the committed
        // mirror is exactly how it comes back on the next clone, so it cannot
        // pass silently.
        setError(
          'The plan was deleted, but .haive-data/plan.json could not be removed. Delete it by hand, or the plan will return the next time this repository is cloned.',
        );
        setBusy(false);
        return;
      }
      onDeleted();
      onOpenChange(false);
    } catch (e) {
      const err = e as ApiError;
      const tasks = (err.body as { tasks?: OpenPlanTask[] } | undefined)?.tasks;
      if (err.code === 'plan_tasks_open' && tasks?.length) setBlockedBy(tasks);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <h2 className="text-sm font-semibold text-neutral-100">Delete this plan</h2>
          <p className="text-xs text-neutral-400">
            {nodeCount} node{nodeCount === 1 ? '' : 's'}, every link between them, every code
            reference, and every plan chat transcript on them.
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Named explicitly, because "delete the plan" sounds like it might
              take the work with it. It does not, and that is worth one line. */}
          <p className="text-xs text-neutral-400">
            Tasks created from plan nodes are <span className="text-neutral-200">kept</span> — only
            their link to the plan goes.
          </p>

          <p className="text-xs text-neutral-500">
            If <code className="text-neutral-300">.haive-data/plan.json</code> has been committed,
            this can be undone by restoring that file from git and re-cloning; node ids survive. If
            it was never committed, there is no way back.
          </p>

          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Type <code className="select-all text-indigo-300">{repoName}</code> to confirm
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              spellCheck={false}
              autoComplete="off"
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
            />
          </label>

          {blockedBy.length > 0 && (
            <ul className="flex flex-col gap-1">
              {blockedBy.map((t) => (
                <li key={t.id}>
                  {/* New tab, deliberately: navigating here would tear down the
                      dialog and the typed confirmation with it, so cancelling
                      the blocker would cost the user the whole delete. `rel`
                      because a target'd link hands the opener over otherwise. */}
                  <Link
                    href={`/tasks/${t.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-300 underline"
                  >
                    {t.title} ↗
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {error && <FormError message={error} />}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void submit()} disabled={!armed}>
              {busy ? 'Deleting…' : 'Delete plan'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
