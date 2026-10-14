'use client';

import { useState } from 'react';
import { postModuleTeardown, type ApiError, type ModuleTeardownResponse } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button, FormError } from '@/components/ui';

export function ModuleTeardownDialog({
  moduleId,
  onClose,
  onDone,
}: {
  moduleId: string | null;
  onClose: () => void;
  onDone: (result: ModuleTeardownResponse) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (running) return;
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!moduleId) return;
    setRunning(true);
    setError(null);
    try {
      onDone(await postModuleTeardown(moduleId));
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to tear the module down');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={moduleId !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="module-teardown-title">
        <DialogHeader>
          <DialogTitle id="module-teardown-title">Tear down module</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300 [overflow-wrap:anywhere]"
            body={`Run the teardown of \`${moduleId}\`? This runs the module's own cleanup in the worker. What it removes is up to the module, and it cannot be undone. The module stays deactivated.`}
          />
        </DialogHeader>
        <FormError message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            disabled={running}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={running}
            onClick={() => void confirm()}
          >
            {running ? 'Tearing down…' : 'Tear down'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
