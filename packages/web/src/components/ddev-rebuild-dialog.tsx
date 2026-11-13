'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

/** Persisted step data proves DDEV exists even when its warm start failed. */
export function canRebuildDdev(
  steps: { stepId: string; status: string; detectOutput: unknown; output: unknown }[],
): boolean {
  if (steps.some((s) => s.status === 'running' || s.status === 'waiting_cli')) return false;
  return steps.some((s) => {
    const detected = s.detectOutput as {
      ddevConfigured?: boolean;
      ddevMode?: boolean;
      mode?: string;
    } | null;
    if (s.stepId === '01c-ddev-env')
      return (
        detected?.ddevConfigured === true ||
        (s.output as { started?: boolean } | null)?.started === true
      );
    if (s.stepId === '08a-browser-setup' || s.stepId === '08a-browser-verify')
      return detected?.ddevMode === true;
    return s.stepId === '99-run-app-ready' && detected?.mode === 'ddev';
  });
}

export function DdevRebuildDialog({
  taskId,
  onClose,
  onQueued,
}: {
  taskId: string | null;
  onClose: () => void;
  onQueued: (notice: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function close() {
    setError(null);
    onClose();
  }
  async function confirm() {
    if (!taskId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ ok: boolean; pending?: boolean }>(
        `/tasks/${taskId}/ddev/rebuild`,
        {},
      );
      onQueued(
        result.pending
          ? 'DDEV rebuild is still pending; removal is not yet confirmed. Check task history for the outcome.'
          : 'DDEV runner removed; recovery is queued. A failed step stays failed; Retry it after the runtime is ready.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue DDEV rebuild');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={taskId !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="ddev-rebuild-title">
        <DialogHeader>
          <DialogTitle id="ddev-rebuild-title">Rebuild DDEV?</DialogTitle>
          <MarkdownView body="The DDEV runner will be removed. The database will be restored from the last snapshot, if one exists; otherwise it starts empty. Every change since that snapshot is lost. A failed step stays failed, so Retry it afterwards." />
        </DialogHeader>
        <FormError message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Queuing...' : 'Rebuild DDEV'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
