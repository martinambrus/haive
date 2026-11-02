'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getIntegrationCategories,
  getTaskIntegrations,
  listIntegrationConnections,
  listIntegrationProviders,
  resetTaskIntegration,
  saveTaskIntegration,
  type TaskIntegrations as Snapshot,
} from '@/lib/api-client';
import {
  statusBadge,
  statusNote,
  type IntegrationConnection,
  type IntegrationProvider,
} from '@/lib/integrations';
import { Button } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

interface Props {
  taskId: string;
  status: string;
  dead: boolean;
}
interface Loaded {
  snapshot: Snapshot;
  providers: IntegrationProvider[];
  connections: IntegrationConnection[];
  labels: { id: string; label: string }[];
}
interface Draft {
  providerId: string;
  connectionId: string;
  remember: boolean;
  forget: boolean;
}
const SELECT =
  'h-10 min-w-0 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 disabled:opacity-50';
const sources: Record<string, string> = {
  task: 'task override',
  grant: 'account retained from an earlier dispatch',
  user: 'your remembered preference',
  admin: 'install default',
  only: 'only eligible account',
  pinned: 'provider requirement',
};
const reasons: Record<string, string> = {
  'no-provider': 'No provider serves this category.',
  'provider-disabled': 'The provider is disabled. Ask an administrator to enable it.',
  'provider-deactivated': 'The provider’s module is deactivated.',
  'provider-missing': 'The provider’s module is no longer available.',
  'no-connection': 'Connect an account in Settings, then refresh.',
  'needs-choice': 'Choose a specific eligible account.',
  'not-allowed-by-repository': 'The repository’s account allow-list excludes this account.',
  'connection-unavailable': 'This account is unavailable. Reconnect it in Settings, then refresh.',
  'no-repository': 'A repository is required for this category.',
  'no-remote': 'The repository needs a remote URL.',
};
const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : 'Could not update integrations. Try Refresh.';

/** A new task gets a new state owner, so an old request cannot populate its controls. */
export function TaskIntegrations(props: Props) {
  return <TaskIntegrationControls key={props.taskId} {...props} />;
}

function TaskIntegrationControls({ taskId, status, dead }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const actionPending = useRef(false);
  const readOnly = dead || status === 'completed' || status === 'cancelled';
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;

  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const [snapshot, providers, connections, labels] = await Promise.all([
        getTaskIntegrations(taskId),
        listIntegrationProviders(),
        listIntegrationConnections(),
        getIntegrationCategories(),
      ]);
      if (!alive.current || request !== sequence.current) return false;
      setLoaded({
        snapshot,
        providers: providers.providers,
        connections: connections.connections,
        labels: labels.categories,
      });
      return true;
    } catch (err) {
      if (alive.current && request === sequence.current) setError(errorMessage(err));
      return false;
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++sequence.current;
    };
    // taskId changes remount this state owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disabled = readOnly || busy || loading || error !== null;
  function edit(categoryId: string, draft: Draft, patch: Partial<Draft>) {
    if (disabled || actionPending.current || readOnlyNow.current) return;
    setDrafts((current) => ({ ...current, [categoryId]: { ...draft, ...patch } }));
    setNotice(null);
  }
  async function mutate(categoryId: string, draft: Draft, reset: boolean) {
    if (disabled || actionPending.current || readOnlyNow.current) return;
    actionPending.current = true;
    ++sequence.current; // Any earlier refresh must settle before a confirmed mutation can be shown.
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (reset) await resetTaskIntegration(taskId, categoryId, draft.forget);
      else
        await saveTaskIntegration(taskId, categoryId, {
          providerId: draft.providerId,
          connectionId: draft.connectionId || null,
          ...(draft.remember ? { remember: true } : {}),
        });
      if (!alive.current) return;
      if (await load()) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[categoryId];
          return next;
        });
        setNotice(
          reset
            ? 'Reset confirmed. Automatic resolution applies from the next dispatch.'
            : 'Saved. This choice applies from the next dispatch.',
        );
      }
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      actionPending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const providerLabel = (id: string | null) =>
    loaded?.providers.find((provider) => provider.id === id)?.displayName ??
    id ??
    'Unknown provider';
  const accountLabel = (id: string | null) => {
    if (!id) return 'no specific account';
    const account = loaded?.connections.find((connection) => connection.id === id);
    return account
      ? `${account.accountLabel} (${statusBadge(account.status).label})`
      : `Unavailable account (${id})`;
  };

  return (
    <div className="min-w-0 space-y-4">
      <InlineMarkdown
        body="Integration changes apply from the next dispatch. Running invocations keep their original accounts and permissions. Choosing an account does not enable write access."
        className="text-sm text-neutral-400"
      />
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/settings/integrations"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 underline"
        >
          Integration Settings (new tab)
        </a>
        <Button
          variant="secondary"
          disabled={loading || busy}
          onClick={() => {
            if (!actionPending.current) {
              setNotice(null);
              void load();
            }
          }}
        >
          Refresh
        </Button>
      </div>
      {readOnly && (
        <InlineMarkdown
          body={
            dead
              ? 'This task is dead. Its integrations are read-only.'
              : `This task is ${status}. Its integrations are read-only.`
          }
          className="text-sm text-amber-300"
        />
      )}
      {loading && (
        <InlineMarkdown body="Loading integrations…" className="text-sm text-neutral-400" />
      )}
      {error && (
        <div role="alert">
          <InlineMarkdown body={error} className="text-sm text-red-400" />
        </div>
      )}
      {notice && (
        <div role="status">
          <InlineMarkdown body={notice} className="text-sm text-green-400" />
        </div>
      )}
      {loaded?.snapshot.categories.length === 0 && (
        <InlineMarkdown
          body="No integration categories are available for this task."
          className="text-sm text-neutral-400"
        />
      )}
      {loaded?.snapshot.categories.map((resolution) => {
        const categoryId = resolution.categoryId;
        const label =
          loaded.labels.find((category) => category.id === categoryId)?.label ?? categoryId;
        const saved = loaded.snapshot.choices.find((choice) => choice.categoryId === categoryId);
        const grant = loaded.snapshot.grants.some((entry) => entry.categoryId === categoryId);
        const draft = drafts[categoryId] ?? {
          providerId: saved?.providerId ?? '',
          connectionId: saved?.connectionId ?? '',
          remember: false,
          forget: false,
        };
        const providers = loaded.providers.filter((provider) =>
          provider.categories.includes(categoryId),
        );
        const offered = providers.filter((provider) => provider.enabled);
        const accounts = loaded.connections.filter(
          (account) =>
            account.providerId === draft.providerId && resolution.candidates.includes(account.id),
        );
        const selectedOffered = offered.some((provider) => provider.id === draft.providerId);
        const selectedAccount = accounts.some((account) => account.id === draft.connectionId);
        const selected = loaded.connections.find(
          (account) => account.id === resolution.connectionId,
        );
        // Dynamic labels are plain React text; only static explanation and server prose enter MarkdownView.
        return (
          <fieldset
            key={categoryId}
            className="min-w-0 space-y-3 rounded-lg border border-neutral-800 p-4"
          >
            <legend className="max-w-full break-words px-1 font-medium text-neutral-100">
              {label}
            </legend>
            <div className="break-words text-sm text-neutral-300">
              <div>
                Current resolution:{' '}
                {resolution.status === 'resolved'
                  ? `${providerLabel(resolution.providerId)} — ${accountLabel(resolution.connectionId)}`
                  : 'Unresolved'}
              </div>
              {resolution.source && (
                <div>Source: {sources[resolution.source] ?? resolution.source}</div>
              )}
              {resolution.status === 'unresolved' && (
                <>
                  <div>Reason: {resolution.reason}</div>
                  {(resolution.providerId || resolution.connectionId) && (
                    <div>
                      {providerLabel(resolution.providerId)} —{' '}
                      {accountLabel(resolution.connectionId)}
                    </div>
                  )}
                </>
              )}
              <div>
                Task override:{' '}
                {saved
                  ? `${providerLabel(saved.providerId)} — ${accountLabel(saved.connectionId)}`
                  : 'None (automatic resolution)'}
              </div>
              {grant && (
                <div>An account retained from an earlier dispatch will be cleared by Reset.</div>
              )}
              {resolution.skipped.map((skip, i) => (
                <div key={i}>
                  Skipped {skip.tier}: {providerLabel(skip.providerId)} — {skip.why}
                </div>
              ))}
            </div>
            {resolution.reason && (
              <InlineMarkdown
                body={
                  reasons[resolution.reason] ??
                  'This integration could not be resolved. Check Settings, then refresh or reset the task override.'
                }
                className="text-sm text-amber-300"
              />
            )}
            {selected && statusNote(selected) && (
              <InlineMarkdown body={statusNote(selected)!} className="text-sm text-amber-300" />
            )}
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="min-w-0 text-sm text-neutral-300">
                Provider for {label}
                <select
                  aria-label={`Provider for ${label}`}
                  className={SELECT}
                  disabled={disabled}
                  value={draft.providerId}
                  onChange={(event) =>
                    edit(categoryId, draft, { providerId: event.target.value, connectionId: '' })
                  }
                >
                  <option value="">Choose a provider</option>
                  {draft.providerId && !selectedOffered && (
                    <option value={draft.providerId}>
                      {providerLabel(draft.providerId)} (unavailable)
                    </option>
                  )}
                  {offered.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-sm text-neutral-300">
                Account for {label}
                <select
                  aria-label={`Account for ${label}`}
                  className={SELECT}
                  disabled={disabled || !draft.providerId}
                  value={draft.connectionId}
                  onChange={(event) =>
                    edit(categoryId, draft, { connectionId: event.target.value })
                  }
                >
                  <option value="">No specific account (asks for a choice)</option>
                  {draft.connectionId && !selectedAccount && (
                    <option value={draft.connectionId}>
                      {accountLabel(draft.connectionId)} — unavailable for this task
                    </option>
                  )}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.accountLabel} ({statusBadge(account.status).label})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex items-start gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={draft.remember}
                disabled={disabled}
                onChange={(event) => edit(categoryId, draft, { remember: event.target.checked })}
              />
              Also for my later tasks
            </label>
            <Button
              disabled={disabled || !draft.providerId}
              onClick={() => void mutate(categoryId, draft, false)}
            >
              Save {label} override
            </Button>
            <label className="flex items-start gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={draft.forget}
                disabled={disabled}
                onChange={(event) => edit(categoryId, draft, { forget: event.target.checked })}
              />
              Also clear my remembered preference for {label}
            </label>
            <Button
              variant="secondary"
              disabled={disabled || (!saved && !grant && !draft.forget)}
              onClick={() => void mutate(categoryId, draft, true)}
            >
              Reset {label} to automatic
            </Button>
            <InlineMarkdown
              body="Reset clears this task’s override and retained account. Your remembered preference stays unless you explicitly choose to clear it above."
              className="text-xs text-neutral-500"
            />
          </fieldset>
        );
      })}
    </div>
  );
}
