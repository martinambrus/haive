'use client';

import { Badge, Button } from '@/components/ui';
import {
  authMethodLabel,
  reconnectOffer,
  statusBadge,
  statusNote,
  type ConnectMethod,
  type IntegrationConnection,
  type IntegrationProvider,
} from '@/lib/integrations';

export function ConnectionRow({
  connection,
  provider,
  credentialLabel,
  busy,
  onReconnect,
  onDisconnect,
}: {
  connection: IntegrationConnection;
  provider: IntegrationProvider | undefined;
  credentialLabel: string | null;
  busy: boolean;
  onReconnect: (method: ConnectMethod) => void;
  onDisconnect: () => void;
}) {
  const providerName = provider?.displayName ?? connection.providerId;
  const badge = statusBadge(connection.status);
  const note = statusNote(connection);
  const offer = reconnectOffer(connection, provider);

  return (
    <li
      data-connection-id={connection.id}
      className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-neutral-100">{providerName}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <span className="text-sm text-neutral-200 [overflow-wrap:anywhere]">
          {connection.accountLabel}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
          <span>{authMethodLabel(connection.authMethod)}</span>
          {connection.grantedScopes.length > 0 && (
            <span className="min-w-0 [overflow-wrap:anywhere]">
              Scopes: <span className="font-mono">{connection.grantedScopes.join(', ')}</span>
            </span>
          )}
          <span>Connected {new Date(connection.createdAt).toLocaleDateString()}</span>
        </div>
        {connection.repoCredentialId !== null && (
          <p className="text-xs text-neutral-400 [overflow-wrap:anywhere]">
            {credentialLabel
              ? `Uses the Git credential "${credentialLabel}".`
              : 'Uses a Git credential.'}
          </p>
        )}
        {note && <p className="text-xs text-amber-300 [overflow-wrap:anywhere]">{note}</p>}
        {offer?.reason === 'write_access' && (
          <p className="text-xs text-amber-300">Reconnect to grant write access</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {offer && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="max-sm:h-11"
            disabled={busy || offer.method === null}
            title={offer.method === null ? `No sign-in is set up for ${providerName}` : undefined}
            aria-label={`Reconnect ${connection.accountLabel} on ${providerName}`}
            onClick={() => offer.method && onReconnect(offer.method)}
          >
            Reconnect
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="max-sm:h-11"
          disabled={busy}
          aria-label={`Disconnect ${connection.accountLabel} from ${providerName}`}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    </li>
  );
}
