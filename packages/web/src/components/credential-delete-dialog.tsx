'use client';

import { useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';

export function CredentialDeleteDialog({
  credential,
  onClose,
  onDeleted,
}: {
  credential: {
    id: string;
    label: string;
    connection?: { accountLabel: string; providerName: string } | null;
  } | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/repo-credentials/${credential.id}`);
      onDeleted(credential.id);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to delete credential');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog className="mx-4" open={credential !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="credential-delete-title">
        <DialogHeader>
          <DialogTitle id="credential-delete-title">Delete Git credential</DialogTitle>
          {credential && (
            <p className="text-sm text-neutral-300 [overflow-wrap:anywhere]">
              {credential.connection
                ? `Delete the Git credential "${credential.label}"? It is the connection to ${credential.connection.accountLabel} on ${credential.connection.providerName}, so that connection is deleted with it. This cannot be undone.`
                : `Delete the Git credential "${credential.label}"? This cannot be undone.`}
            </p>
          )}
        </DialogHeader>
        <FormError message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
