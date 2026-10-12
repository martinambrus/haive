'use client';

import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { api, type TaskEvent } from '@/lib/api-client';
import { leftMergeBanners } from '@/lib/step-banners';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button, FormError } from '@/components/ui';

const POLL_MS = 3000;
const IDLE_POLLS = 20;

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
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (taskStatus !== 'cancelled') return;
    let stop = false;
    let idle = 0;
    const load = async () => {
      try {
        const data = await api.get<{ events: TaskEvent[] }>(
          `/tasks/${taskId}/events?type=merge.left_open,merge.left_open_settled`,
        );
        if (stop) return;
        setEvents(data.events);
        const open = leftMergeBanners(data.events, { taskStatus }).some((b) => b.canAbort);
        idle = open ? 0 : idle + 1;
        if (idle >= IDLE_POLLS) clearInterval(timer);
      } catch {
        // the next poll tries again
      }
    };
    const timer = setInterval(() => void load(), POLL_MS);
    void load();
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [taskId, taskStatus]);

  const banners = leftMergeBanners(events, { taskStatus });
  if (banners.length === 0) return null;

  async function abort(dir: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tasks/${taskId}/merges/abort`, { dir });
      setRequested((prev) => new Set(prev).add(dir));
      setConfirming(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {banners.map((b, i) => (
        <div
          key={`${i}:${b.dir}`}
          role="status"
          className="flex items-start gap-3 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-amber-300"
        >
          <GitMerge className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <InlineMarkdown className="text-sm [overflow-wrap:anywhere]" body={b.text} />
            {b.canAbort &&
              (requested.has(b.dir) ? (
                <span className="text-xs opacity-80">Aborting…</span>
              ) : (
                <div>
                  <Button size="sm" variant="destructive" onClick={() => setConfirming(b.dir)}>
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
              body={banners.find((b) => b.dir === confirming)?.text ?? ''}
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
