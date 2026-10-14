'use client';

import { useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
import type { IntegrationConnection } from '@/lib/integrations';

export type Revoked = 'yes' | 'no' | 'n/a';

export function DisconnectDialog({
  connection,
  providerName,
  credentialLabel,
  onClose,
  onDisconnected,
}: {
  connection: IntegrationConnection | null;
  providerName: string;
  credentialLabel: string | null;
  onClose: () => void;
  onDisconnected: (connection: IntegrationConnection, revoked: Revoked) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.delete<{ ok: boolean; revoked: Revoked }>(
        `/integrations/connections/${encodeURIComponent(connection.id)}`,
      );
      onDisconnected(connection, res.revoked);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog className="mx-4" open={connection !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="disconnect-title">
        <DialogHeader>
          <DialogTitle id="disconnect-title">Disconnect {providerName}</DialogTitle>
          {connection && (
            <p className="text-sm text-neutral-300 [overflow-wrap:anywhere]">
              {connection.repoCredentialId !== null
                ? `Remove the connection to ${connection.accountLabel}? Only the connection goes. The Git credential${credentialLabel ? ` "${credentialLabel}"` : ''} stays, and so do the repositories that use it.`
                : `Remove the connection to ${connection.accountLabel}? Haive forgets it and asks ${providerName} to revoke its access token where that is possible.`}
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
            {busy ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
