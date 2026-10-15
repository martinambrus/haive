'use client';

import { useEffect, useState } from 'react';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import {
  listAdminIntegrationDefaults,
  saveAdminIntegrationDefault,
  type ApiError,
  type IntegrationDefault,
} from '@/lib/api-client';
import type { AdminIntegrationProvider } from '@/lib/admin-integrations';
import { Button, FormError } from '@/components/ui';
import { enabledServing } from '@/lib/integrations';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 disabled:opacity-50 sm:w-auto sm:max-w-xs';

export function DefaultsByKind({ providers }: { providers: AdminIntegrationProvider[] }) {
  const [defaults, setDefaults] = useState<IntegrationDefault[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ categoryId: string; message: string } | null>(null);

  useEffect(() => {
    void listAdminIntegrationDefaults()
      .then((res) => setDefaults(res.defaults))
      .catch((err: ApiError) => setLoadError(err.message ?? 'Failed to load the install defaults'));
  }, []);

  async function save(categoryId: string, providerId: string | null) {
    setBusy(true);
    setFailure(null);
    try {
      await saveAdminIntegrationDefault(categoryId, providerId);
      setDefaults((current) => [
        ...(current ?? []).filter((row) => row.categoryId !== categoryId),
        ...(providerId === null ? [] : [{ categoryId, providerId }]),
      ]);
    } catch (err) {
      setFailure({
        categoryId,
        message: (err as ApiError).message ?? 'Failed to save the default',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="defaults-by-kind-heading">
      <div>
        <h2 id="defaults-by-kind-heading" className="text-lg font-semibold text-neutral-50">
          Defaults by kind
        </h2>
        <p className="max-w-3xl text-sm text-neutral-400">
          The provider Haive uses for a kind of integration when a user has not chosen one. Only
          enabled providers that serve the kind are offered.
        </p>
      </div>

      <FormError message={loadError} />
      {defaults === null && !loadError && <p className="text-sm text-neutral-400">Loading…</p>}

      {defaults && (
        <ul className="flex flex-col gap-3">
          {CORE_INTEGRATION_CATEGORY_SPECS.map(({ id, label }) => {
            const offered = enabledServing(id, providers);
            const saved = defaults.find((row) => row.categoryId === id);
            return (
              <li
                key={id}
                data-category-id={id}
                className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 px-4 py-3"
              >
                <h3 className="text-sm font-medium text-neutral-100">{label}</h3>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <select
                    aria-label={`${label} default provider`}
                    className={SELECT_CLASS}
                    value={
                      saved && offered.some((p) => p.id === saved.providerId)
                        ? saved.providerId
                        : ''
                    }
                    disabled={busy || offered.length === 0}
                    onChange={(e) => void save(id, e.target.value)}
                  >
                    <option value="" disabled>
                      {offered.length > 0 ? 'No default' : 'No enabled provider'}
                    </option>
                    {offered.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="max-sm:h-11"
                    aria-label={`Clear ${label} default`}
                    disabled={busy || saved === undefined}
                    onClick={() => void save(id, null)}
                  >
                    Clear
                  </Button>
                </div>
                {failure?.categoryId === id && <FormError message={failure.message} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
