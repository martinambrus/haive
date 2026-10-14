'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import { Card, FormError } from '@/components/ui';
import { ConnectionRow } from '@/components/integrations/connection-row';
import { DeviceSignInDialog } from '@/components/integrations/device-sign-in-dialog';
import { DisconnectDialog, type Revoked } from '@/components/integrations/disconnect-dialog';
import { GithubClientCard } from '@/components/integrations/github-client-card';
import { ProviderCard } from '@/components/integrations/provider-card';
import {
  disconnectNotice,
  isHttpsUrl,
  linkableCredentials,
  type ConnectMethod,
  type GitCredentialRow,
  type IntegrationConnection,
  type IntegrationProvider,
} from '@/lib/integrations';
import { useDeviceSignIn } from '@/lib/use-device-sign-in';

const providerPath = (providerId: string) =>
  `/integrations/providers/${encodeURIComponent(providerId)}`;

export default function IntegrationsPage() {
  usePageTitle('Integrations');
  const [providers, setProviders] = useState<IntegrationProvider[] | null>(null);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [credentials, setCredentials] = useState<GitCredentialRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState<IntegrationConnection | null>(null);

  const load = useCallback(async () => {
    try {
      const [listed, owned, saved] = await Promise.all([
        api.get<{ providers: IntegrationProvider[] }>('/integrations/providers'),
        api.get<{ connections: IntegrationConnection[] }>('/integrations/connections'),
        api.get<{ credentials: GitCredentialRow[] }>('/repo-credentials'),
      ]);
      setProviders(listed.providers);
      setConnections(owned.connections);
      setCredentials(saved.credentials);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Failed to load integrations');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providerOf = (providerId: string) => providers?.find((p) => p.id === providerId);
  const nameOf = (providerId: string) => providerOf(providerId)?.displayName ?? providerId;
  const credentialLabelOf = (id: string | null) =>
    credentials.find((credential) => credential.id === id)?.label ?? null;

  const device = useDeviceSignIn((connection) => {
    setNotice(`${nameOf(connection.providerId)} connected as ${connection.accountLabel}.`);
    void load();
  });

  async function connectWith(provider: IntegrationProvider, method: ConnectMethod) {
    setError(null);
    setNotice(null);
    if (method === 'device') {
      void device.start(provider.id);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ authorizeUrl: string }>(
        `${providerPath(provider.id)}/connect`,
        {},
      );
      if (!isHttpsUrl(res.authorizeUrl)) {
        throw new Error(`${provider.displayName} sent a sign-in address that cannot be used`);
      }
      window.location.assign(res.authorizeUrl);
    } catch (err) {
      setError(
        (err as Error).message ?? `Failed to start the sign-in with ${provider.displayName}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function setWriteSwitch(provider: IntegrationProvider, next: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.put<{ providerId: string; writeEnabled: boolean }>(
        `${providerPath(provider.id)}/write`,
        { writeEnabled: next },
      );
      setProviders(
        (rows) =>
          rows?.map((row) =>
            row.id === res.providerId ? { ...row, writeEnabled: res.writeEnabled } : row,
          ) ?? null,
      );
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save the write switch');
    } finally {
      setBusy(false);
    }
  }

  async function useAsConnection(provider: IntegrationProvider, credential: GitCredentialRow) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`${providerPath(provider.id)}/link-credential`, {
        repoCredentialId: credential.id,
      });
      setNotice(`"${credential.label}" is now a ${provider.displayName} connection.`);
      await load();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to use the credential as a connection');
      if ((err as ApiError).status === 409) await load();
    } finally {
      setBusy(false);
    }
  }

  function disconnected(connection: IntegrationConnection, revoked: Revoked) {
    setDisconnecting(null);
    setError(null);
    setNotice(disconnectNotice(connection, nameOf(connection.providerId), revoked));
    void load();
  }

  function reconnect(connection: IntegrationConnection, method: ConnectMethod) {
    const provider = providerOf(connection.providerId);
    if (provider) void connectWith(provider, method);
  }

  const enabledProviders = providers?.filter((provider) => provider.enabled) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Integrations</h2>
        <p className="text-sm text-neutral-400">
          Connect external services for repository access and authentication.
        </p>
      </div>

      <FormError message={loadError} />
      <FormError message={error} />
      {notice && (
        <div
          role="status"
          className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200"
        >
          {notice}
        </div>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="connections-heading">
        <h3 id="connections-heading" className="text-base font-semibold text-neutral-50">
          Connections
        </h3>
        {providers === null && !loadError && <p className="text-sm text-neutral-400">Loading...</p>}
        {providers !== null && connections.length === 0 && (
          <Card className="p-4 text-sm text-neutral-400">
            No connections yet. Sign in to a provider below, or use a Git credential you already
            saved.
          </Card>
        )}
        {connections.length > 0 && (
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                provider={providerOf(connection.providerId)}
                credentialLabel={credentialLabelOf(connection.repoCredentialId)}
                busy={busy}
                onReconnect={(method) => reconnect(connection, method)}
                onDisconnect={() => setDisconnecting(connection)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="providers-heading">
        <h3 id="providers-heading" className="text-base font-semibold text-neutral-50">
          Providers
        </h3>
        <p className="max-w-3xl text-xs text-neutral-400">
          Allow write access is off until you turn it on. When it is on, signing in to a provider
          also asks it for write access. Nothing in Haive acts for you through a connection yet, and
          the pull requests your workflows open do not depend on this switch.
        </p>
        {enabledProviders.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            linkable={linkableCredentials(provider.id, credentials, connections)}
            busy={busy}
            onConnect={(method) => void connectWith(provider, method)}
            onWriteSwitch={(next) => void setWriteSwitch(provider, next)}
            onLink={(credential) => void useAsConnection(provider, credential)}
          />
        ))}
        {providers !== null && enabledProviders.length === 0 && (
          <p className="text-sm text-neutral-400">
            No provider is enabled on this server. An administrator can turn them on under Admin,
            Integrations.
          </p>
        )}
      </section>

      <GithubClientCard onChanged={() => void load()} />

      <DeviceSignInDialog
        phase={device.phase}
        providerName={device.phase.kind === 'idle' ? '' : nameOf(device.phase.providerId)}
        onCancel={device.cancel}
        onRetry={(providerId) => void device.start(providerId)}
      />
      <DisconnectDialog
        connection={disconnecting}
        providerName={disconnecting ? nameOf(disconnecting.providerId) : ''}
        credentialLabel={disconnecting ? credentialLabelOf(disconnecting.repoCredentialId) : null}
        onClose={() => setDisconnecting(null)}
        onDisconnected={disconnected}
      />
    </div>
  );
}
