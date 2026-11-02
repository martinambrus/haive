'use client';

import { useEffect, useState } from 'react';
import {
  clearIntegrationPreference,
  getIntegrationCategories,
  listIntegrationConnections,
  listIntegrationDefaults,
  listIntegrationPreferences,
  listIntegrationProviders,
  saveIntegrationPreference,
  type ApiError,
  type IntegrationDefault,
  type IntegrationPreference,
} from '@/lib/api-client';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button, FormError } from '@/components/ui';
import {
  categoryRows,
  integrationDisplayBody,
  enabledServing,
  type IntegrationCategory,
  type IntegrationConnection,
  type IntegrationProvider,
} from '@/lib/integrations';

interface Loaded {
  categories: IntegrationCategory[];
  providers: IntegrationProvider[];
  connections: IntegrationConnection[];
  preferences: IntegrationPreference[];
  defaults: IntegrationDefault[];
}

/** What a row's selects show; an empty string is the placeholder, or Any account. */
interface Choice {
  providerId: string;
  connectionId: string;
}

const NO_CHOICE: Choice = { providerId: '', connectionId: '' };

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 disabled:opacity-50 sm:w-auto sm:max-w-xs';

function choiceOf(
  saved: IntegrationPreference | undefined,
  offered: readonly IntegrationProvider[],
): Choice {
  return saved && offered.some((provider) => provider.id === saved.providerId)
    ? { providerId: saved.providerId, connectionId: saved.connectionId ?? '' }
    : NO_CHOICE;
}

function statusLine(
  saved: IntegrationPreference | undefined,
  fallback: IntegrationDefault | undefined,
  loaded: Loaded,
): string {
  const nameOf = (providerId: string) =>
    loaded.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;
  if (saved) {
    const account = loaded.connections.find((connection) => connection.id === saved.connectionId);
    const who = account ? `account ${account.accountLabel}` : 'any account';
    return `Your choice: ${nameOf(saved.providerId)}, ${who}.`;
  }
  if (fallback) {
    return `No choice of yours, so the install default applies: ${nameOf(fallback.providerId)}.`;
  }
  return 'No choice of yours and no install default.';
}

export function PreferredByKind() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ categoryId: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getIntegrationCategories(),
      listIntegrationProviders(),
      listIntegrationConnections(),
      listIntegrationPreferences(),
      listIntegrationDefaults(),
    ])
      .then(
        ([categories, providers, connections, preferences, defaults]) =>
          active &&
          setLoaded({
            categories: categories.categories,
            providers: providers.providers,
            connections: connections.connections,
            preferences: preferences.preferences,
            defaults: defaults.defaults,
          }),
      )
      .catch(
        (err: ApiError) =>
          active && setLoadError(err.message ?? 'Failed to load your integration preferences'),
      );
    return () => {
      active = false;
    };
  }, []);

  async function run(categoryId: string, action: () => Promise<void>, failed: string) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure({ categoryId, message: (err as ApiError).message ?? failed });
    } finally {
      setBusy(false);
    }
  }

  function save(categoryId: string, choice: Choice) {
    const body = { providerId: choice.providerId, connectionId: choice.connectionId || null };
    return run(
      categoryId,
      async () => {
        await saveIntegrationPreference(categoryId, body);
        setLoaded(
          (current) =>
            current && {
              ...current,
              preferences: [
                ...current.preferences.filter((row) => row.categoryId !== categoryId),
                { categoryId, ...body },
              ],
            },
        );
      },
      'Failed to save the preference',
    );
  }

  function clear(categoryId: string) {
    return run(
      categoryId,
      async () => {
        await clearIntegrationPreference(categoryId);
        setLoaded(
          (current) =>
            current && {
              ...current,
              preferences: current.preferences.filter((row) => row.categoryId !== categoryId),
            },
        );
        setChoices((current) => ({ ...current, [categoryId]: NO_CHOICE }));
      },
      'Failed to clear the preference',
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Preferred by kind</h2>
        <p className="max-w-3xl text-sm text-neutral-400">
          Choose which provider, and optionally which of your accounts with it, Haive uses for each
          kind of integration. Where you choose nothing, the install default applies.
        </p>
      </div>

      <FormError message={loadError} />
      {loaded === null && !loadError && <p className="text-sm text-neutral-400">Loading...</p>}

      {loaded && (
        <ul className="flex flex-col gap-3">
          {categoryRows(
            loaded.categories,
            [...loaded.preferences, ...loaded.defaults].map((row) => row.categoryId),
          ).map(({ id, label, available }) => {
            const offered = available ? enabledServing(id, loaded.providers) : [];
            const saved = loaded.preferences.find((row) => row.categoryId === id);
            const fallback = loaded.defaults.find((row) => row.categoryId === id);
            const choice = choices[id] ?? choiceOf(saved, offered);
            const accounts = loaded.connections.filter(
              (connection) => connection.providerId === choice.providerId,
            );
            return (
              <li
                key={id}
                data-category-id={id}
                className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 px-4 py-3"
              >
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium text-neutral-100 [overflow-wrap:anywhere]">
                    {label}
                  </h3>
                  <InlineMarkdown
                    className="text-xs text-neutral-400 [overflow-wrap:anywhere]"
                    body={integrationDisplayBody(statusLine(saved, fallback, loaded))}
                  />
                  {!available && (
                    <InlineMarkdown
                      className="text-xs text-amber-300"
                      body="Category unavailable on this install. A saved preference can still be cleared."
                    />
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <select
                    aria-label={`${label} provider`}
                    className={SELECT_CLASS}
                    value={choice.providerId}
                    disabled={busy || offered.length === 0}
                    onChange={(e) =>
                      setChoices({
                        ...choices,
                        [id]: { providerId: e.target.value, connectionId: '' },
                      })
                    }
                  >
                    <option value="">
                      {offered.length > 0 ? 'Choose a provider' : 'No enabled provider'}
                    </option>
                    {offered.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                  {choice.providerId !== '' && (
                    <select
                      aria-label={`${label} account`}
                      className={SELECT_CLASS}
                      value={choice.connectionId}
                      disabled={busy}
                      onChange={(e) =>
                        setChoices({
                          ...choices,
                          [id]: { ...choice, connectionId: e.target.value },
                        })
                      }
                    >
                      <option value="">Any account</option>
                      {accounts.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.accountLabel}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="max-sm:h-11"
                      aria-label={`Save ${label}`}
                      disabled={busy || choice.providerId === ''}
                      onClick={() => void save(id, choice)}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="max-sm:h-11"
                      aria-label={`Clear ${label}`}
                      disabled={busy || saved === undefined}
                      onClick={() => void clear(id)}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                {failure?.categoryId === id && <FormError message={failure.message} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
