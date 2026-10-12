'use client';

import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { api, type TaskEvent } from '@/lib/api-client';
import { leftMergeBanners } from '@/lib/step-banners';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button, FormError } from '@/components/ui';

const POLL_MS = 3000;
const CANCEL_FINISHED = 'task.cancel_finished';

const ABORT_CONFIRM =
  'The half-finished merge is undone and the checkout goes back to how it was before the merge started. Changes the fixer made outside the conflicting files are moved aside first where Haive still has a record of them. This cannot be undone.';

/** A cancelled task can leave a merge open in a directory it merged in. Shows each one, and lets the
 *  person abort it behind a confirm. Which banners exist is decided by `leftMergeBanners`. */
export function TaskLeftMergeBanner({
  taskId,
  taskStatus,
}: {
  taskId: string;
  taskStatus: string;
}) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [requested, setRequested] = useState<ReadonlyMap<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const banners = leftMergeBanners(events, { taskStatus });
  const inFlight = (key: string) => {
    const b = banners.find((x) => x.key === key && x.canAbort);
    return b !== undefined && requested.get(key) === b.refusals;
  };
  // The cancel records its reports before `task.cancel_finished`, so polling may stop once that is
  // in and no abort is waiting on its outcome.
  const polling =
    !events.some((e) => e.eventType === CANCEL_FINISHED) || banners.some((b) => inFlight(b.key));

  useEffect(() => {
    if (taskStatus !== 'cancelled') return;
    let stop = false;
    const load = async () => {
      try {
        const data = await api.get<{ events: TaskEvent[] }>(
          `/tasks/${taskId}/events?type=merge.left_open,merge.left_open_settled,${CANCEL_FINISHED}`,
        );
        if (!stop) setEvents(data.events);
      } catch {
        // the next poll tries again
      }
    };
    void load();
    const timer = polling ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [taskId, taskStatus, polling]);

  if (banners.length === 0) return null;

  async function abort(key: string): Promise<void> {
    const target = banners.find((b) => b.key === key);
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tasks/${taskId}/merges/abort`, {
        dir: target.dir,
        mergeHead: target.mergeHead,
      });
      setRequested((prev) => new Map(prev).set(key, target.refusals));
      setConfirming(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {banners.map((b) => (
        <div
          key={b.key}
          role="status"
          className="flex items-start gap-3 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-amber-300"
        >
          <GitMerge className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <InlineMarkdown className="text-sm [overflow-wrap:anywhere]" body={b.text} />
            {b.canAbort &&
              (inFlight(b.key) ? (
                <span className="text-xs opacity-80">Aborting…</span>
              ) : (
                <div>
                  <Button size="sm" variant="destructive" onClick={() => setConfirming(b.key)}>
                    Abort merge
                  </Button>
                </div>
              ))}
          </div>
        </div>
      ))}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Abort this merge?</DialogTitle>
            <InlineMarkdown className="text-sm text-neutral-400" body={ABORT_CONFIRM} />
          </DialogHeader>
          {confirming && (
            <InlineMarkdown
              className="text-xs text-neutral-400"
              body={banners.find((b) => b.key === confirming)?.text ?? ''}
            />
          )}
          {error && <FormError message={error} />}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => confirming && void abort(confirming)}
              disabled={busy}
            >
              {busy ? 'Aborting…' : 'Abort merge'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
