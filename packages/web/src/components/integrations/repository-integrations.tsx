'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  getRepositoryIntegrations,
  listIntegrationConnections,
  listIntegrationProviders,
  saveRepositoryIntegrations,
  type ApiError,
} from '@/lib/api-client';
import { Button, Card, FormError, Label } from '@/components/ui';
import type { IntegrationConnection, IntegrationProvider } from '@/lib/integrations';

interface Loaded {
  providers: IntegrationProvider[];
  connections: IntegrationConnection[];
}

function groupsOf({ providers, connections }: Loaded) {
  return [...new Set(connections.map((connection) => connection.providerId))].map((providerId) => ({
    providerId,
    name: providers.find((provider) => provider.id === providerId)?.displayName ?? providerId,
    accounts: connections.filter((connection) => connection.providerId === providerId),
  }));
}

export function RepositoryIntegrations({ repositoryId }: { repositoryId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      getRepositoryIntegrations(repositoryId),
      listIntegrationProviders(),
      listIntegrationConnections(),
    ])
      .then(([list, providers, connections]) => {
        setRestricted(list.restricted);
        setTicked(list.connectionIds);
        setLoaded({ providers: providers.providers, connections: connections.connections });
      })
      .catch((err: ApiError) =>
        setLoadError(err.message ?? 'Failed to load the repository integrations'),
      );
  }, [repositoryId]);

  const chosen = loaded?.connections.map((c) => c.id).filter((id) => ticked.includes(id)) ?? [];

  function changed(update: () => void) {
    update();
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveRepositoryIntegrations(repositoryId, { restricted, connectionIds: chosen });
      setSaved(true);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save the repository integrations');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-neutral-100">Integrations</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Choose which of your connected accounts tasks of this repository may use for integrations.
        Left off, any account of yours can be used.
      </p>
      <FormError message={loadError} />
      {loaded === null && !loadError && <p className="mt-3 text-sm text-neutral-500">Loading...</p>}

      {loaded && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <input
              id="integrationsRestricted"
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
              checked={restricted}
              onChange={(e) => changed(() => setRestricted(e.target.checked))}
            />
            <Label htmlFor="integrationsRestricted">Restrict to these accounts</Label>
          </div>

          {restricted && (
            <div className="mt-4 flex flex-col gap-3">
              {loaded.connections.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  You have no connected accounts. Connect one under{' '}
                  <Link
                    href="/settings/integrations"
                    className="text-indigo-300 underline hover:text-indigo-200"
                  >
                    Settings, Integrations
                  </Link>
                  .
                </p>
              ) : (
                groupsOf(loaded).map((group) => (
                  <fieldset key={group.providerId} className="flex flex-col">
                    <legend className="text-sm font-medium text-neutral-200">{group.name}</legend>
                    {group.accounts.map((connection) => (
                      <label
                        key={connection.id}
                        className="flex min-h-11 items-center gap-2 text-sm text-neutral-200"
                      >
                        <input
                          id={`allow-${connection.id}`}
                          type="checkbox"
                          className="h-4 w-4 shrink-0"
                          checked={ticked.includes(connection.id)}
                          onChange={(e) =>
                            changed(() =>
                              setTicked(
                                e.target.checked
                                  ? [...ticked, connection.id]
                                  : ticked.filter((id) => id !== connection.id),
                              ),
                            )
                          }
                        />
                        <span className="[overflow-wrap:anywhere]">{connection.accountLabel}</span>
                      </label>
                    ))}
                  </fieldset>
                ))
              )}
              {chosen.length === 0 && (
                <p className="rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
                  Nothing is ticked, so tasks of this repository can use no account.
                </p>
              )}
            </div>
          )}

          <FormError message={error} />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving...' : 'Save integrations'}
            </Button>
            {saved && (
              <span role="status" className="text-sm text-emerald-400">
                Saved.
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
