'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { ModuleDiffRow, ModuleState } from '@haive/shared/modularity';
import {
  getModulesLoaded,
  getModuleSources,
  fetchModuleSource,
  type ModuleSourcesResponse,
  getModuleDependents,
  cancelModuleDrain,
  patchModuleActive,
  type ApiError,
  type ModulePurgeResponse,
  type ModulesLoadedResponse,
  type ModuleTeardownResponse,
  type ModuleUrgentResponse,
} from '@/lib/api-client';
import { moduleIntegrationCountsCopy } from '@/lib/module-purge';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { usePageTitle } from '@/lib/use-page-title';
import { ModuleActiveCell } from '@/components/module-active-cell';
import { ModulePurgeDialog } from '@/components/module-purge-dialog';
import { ModuleSkippedSeeds } from '@/components/module-skipped-seeds';
import {
  ModuleTasksOpenDialog,
  moduleOffNotice,
  type ModuleTasksBlocked,
} from '@/components/module-tasks-open-dialog';
import { ModuleTeardownDialog } from '@/components/module-teardown-dialog';
import { ModuleSourceDialog, type ModuleSourceTarget } from '@/components/module-source-dialog';
import { Badge, Button, FormError } from '@/components/ui';

const STATE_BADGE: Record<
  ModuleState,
  { variant: 'success' | 'error' | 'warning' | 'info'; label: string }
> = {
  loaded: { variant: 'success', label: 'Loaded' },
  missing: { variant: 'error', label: 'Missing' },
  'api-only': { variant: 'warning', label: 'Api only' },
  'worker-only': { variant: 'warning', label: 'Worker only' },
  unrecorded: { variant: 'info', label: 'Not recorded yet' },
  unknown: { variant: 'info', label: 'Worker not reported' },
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function Versions({ row }: { row: ModuleDiffRow }) {
  return (
    <span className="font-mono text-neutral-300">
      {[row.rowVersion, row.apiVersion, row.workerVersion].map((v) => v ?? '—').join(' / ')}
      {row.versionDrift && (
        <Badge variant="warning" className="ml-2">
          drift
        </Badge>
      )}
    </span>
  );
}

export default function ModulesPage() {
  usePageTitle('Modules');

  const router = useRouter();
  const [sources, setSources] = useState<ModuleSourcesResponse | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceTarget, setSourceTarget] = useState<ModuleSourceTarget | null>(null);
  const [sourcePending, setSourcePending] = useState<ReadonlySet<string>>(new Set());
  const sourceRequests = useRef(new Set<string>());
  const latestSourceLoad = useRef(0);
  const loadSources = useCallback(async () => {
    const request = ++latestSourceLoad.current;
    try {
      const response = await getModuleSources();
      if (request !== latestSourceLoad.current) return;
      setSources(response);
      setSourceError(null);
    } catch (err) {
      if (request === latestSourceLoad.current)
        setSourceError((err as ApiError).message ?? 'Failed to load install sources');
    }
  }, []);
  useEffect(() => {
    void loadSources();
  }, [loadSources]);
  useEffect(() => {
    if (
      !sources?.sources.some(
        (source) => source.fetchStatus === 'queued' || source.fetchStatus === 'fetching',
      )
    )
      return;
    const timer = setInterval(() => void loadSources(), 3000);
    return () => clearInterval(timer);
  }, [sources, loadSources]);
  async function fetchSource(id: string, refresh: boolean) {
    if (sourceRequests.current.has(id)) return;
    sourceRequests.current.add(id);
    setSourcePending(new Set(sourceRequests.current));
    try {
      await fetchModuleSource(id, refresh);
      await loadSources();
    } catch (error) {
      setSourceError((error as ApiError).message ?? 'Failed to queue module fetch');
    } finally {
      sourceRequests.current.delete(id);
      setSourcePending(new Set(sourceRequests.current));
    }
  }
  const [data, setData] = useState<ModulesLoadedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const preflight = useRef(0);
  const latestLoad = useRef(0);
  const [blocked, setBlocked] = useState<ModuleTasksBlocked | null>(null);
  const [tearingDown, setTearingDown] = useState<string | null>(null);
  const [purging, setPurging] = useState<{ id: string; tornDown: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const response = await getModulesLoaded();
      if (request !== latestLoad.current) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (request === latestLoad.current)
        setError((err as ApiError).message ?? 'Failed to load modules');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: ModuleDiffRow) {
    if (pending.current.has(row.id)) return;
    pending.current.add(row.id);
    setBusy(new Set(pending.current));
    const request = ++preflight.current;
    setError(null);
    setNotice(null);
    try {
      if (row.deactivatedAt === null) {
        const response = await getModuleDependents(row.id);
        if (request === preflight.current && response.moduleId === row.id)
          setBlocked({
            ...response,
            name: row.name,
            draining: row.drainingAt != null,
          });
      } else {
        await patchModuleActive(row.id, true);
        await load();
        router.refresh();
      }
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to update the module');
    } finally {
      pending.current.delete(row.id);
      setBusy(new Set(pending.current));
    }
  }

  async function cancelDrain(row: ModuleDiffRow) {
    if (pending.current.has(row.id)) return;
    pending.current.add(row.id);
    setBusy(new Set(pending.current));
    try {
      await cancelModuleDrain(row.id);
      await load();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to cancel the drain');
    } finally {
      pending.current.delete(row.id);
      setBusy(new Set(pending.current));
    }
  }

  useEffect(() => {
    if (!data?.modules.rows.some((row) => row.drainingAt)) return;
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [data, load]);

  useEffect(
    () => () => {
      ++preflight.current;
      ++latestLoad.current;
    },
    [],
  );

  function turnedOff(result: ModuleUrgentResponse) {
    const titles = new Map((blocked?.tasks ?? []).map((t) => [t.id, t.title]));
    setNotice(moduleOffNotice(blocked?.name || result.moduleId, result, titles));
    setBlocked(null);
    void load();
    router.refresh();
  }

  function tornDown(result: ModuleTeardownResponse) {
    setNotice(
      'status' in result
        ? `The teardown of ${tearingDown} is still running in the worker. Reload this page later to see whether it finished.`
        : null,
    );
    setTearingDown(null);
    void load();
  }

  function purged(result: ModulePurgeResponse) {
    const kept = result.taskTypesKept.length;
    setNotice(
      `Purged ${result.moduleId}: deleted its database, ${count(result.configKeysDeleted, 'setting')} and ${count(result.taskTypesDeleted.length, 'task type')}, ${moduleIntegrationCountsCopy(result.integrationsDeleted)}${kept > 0 ? `; kept ${count(kept, 'task type')} that tasks use` : ''}.`,
    );
    setPurging(null);
    void load();
  }

  const workerAt = data?.modules.workerAt ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="max-w-3xl text-sm text-neutral-400">
          The modules this install recorded, and which of them the api and the worker loaded. The
          worker writes the record at each boot. Versions read as recorded / api / worker.
        </p>
        {data && (
          <p className="mt-1 text-sm text-neutral-500" data-testid="worker-report">
            {workerAt === null ? 'No worker report' : `Worker report ${ago(workerAt)}`}
          </p>
        )}
      </div>
      <FormError message={error} />
      {notice !== null && (
        <div
          role="status"
          className="whitespace-pre-line rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
        >
          <InlineMarkdown body={notice} />
        </div>
      )}
      {data && (
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-xs uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2">Module</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Versions</th>
                <th className="px-3 py-2">Entitlement</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2">Last loaded</th>
                <th className="px-3 py-2">Missing since</th>
              </tr>
            </thead>
            <tbody>
              {data.modules.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-4 text-neutral-500">
                    No modules recorded or loaded.
                  </td>
                </tr>
              )}
              {data.modules.rows.map((row) => (
                <tr
                  key={row.id}
                  data-module-id={row.id}
                  data-state={row.state}
                  className="border-t border-neutral-800"
                >
                  <td className="px-3 py-2 font-mono text-neutral-200">{row.id}</td>
                  <td className="px-3 py-2 text-neutral-300">{row.name ?? '—'}</td>
                  <td className="px-3 py-2 text-neutral-400">{row.source ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Versions row={row} />
                  </td>
                  <td className="px-3 py-2 font-mono text-neutral-400">
                    {row.entitlementId ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={STATE_BADGE[row.state].variant}>
                      {STATE_BADGE[row.state].label}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <ModuleActiveCell
                      row={row}
                      busy={busy.has(row.id)}
                      onCancelDrain={() => void cancelDrain(row)}
                      onToggle={() => void toggle(row)}
                      onTeardown={() => setTearingDown(row.id)}
                      onPurge={() => setPurging({ id: row.id, tornDown: row.tornDownAt !== null })}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                    {when(row.lastLoadedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                    {when(row.missingAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-neutral-100">Install sources</h2>
          {sources?.writable && (
            <Button onClick={() => setSourceTarget({ mode: 'add' })}>Add source</Button>
          )}
        </div>
        <InlineMarkdown
          className="text-sm text-neutral-400"
          body="Fetch pins module sources for the next upgrade or explicit Build. Refresh resolves a newer Git commit. Deleting a source keeps its pinned folder."
        />
        {sources?.writable && !sources.fetchConfigured && (
          <InlineMarkdown
            className="text-sm text-neutral-400"
            body="Set `HAIVE_OWN_MODULES_HOST_DIR` to an existing prepared directory on the Docker host to enable Fetch."
          />
        )}
        <FormError message={sourceError} />
        {sourceError && (
          <Button variant="secondary" onClick={() => void loadSources()}>
            Retry sources
          </Button>
        )}
        {sources && !sources.writable && (
          <InlineMarkdown
            className="text-sm text-neutral-400"
            body="Install sources are read-only on a source checkout. Use the repository command: `pnpm module add`."
          />
        )}
        {sources?.sources.length === 0 && (
          <InlineMarkdown
            className="text-sm text-neutral-500"
            body="No install sources recorded."
          />
        )}
        {sources && sources.sources.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr>
                  <th className="p-2">Module</th>
                  <th className="p-2">Source</th>
                  <th className="p-2">Ref / version</th>
                  <th className="p-2">Token</th>
                  <th className="p-2">Fetch status</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.sources.map((source) => (
                  <tr key={source.id} className="border-t border-neutral-800">
                    <td className="p-2 font-mono">{source.moduleId}</td>
                    <td className="p-2">
                      <code>{source.url ?? source.packageName}</code>
                    </td>
                    <td className="p-2 font-mono">{source.ref ?? source.version}</td>
                    <td className="p-2">{source.hasToken ? 'Stored' : 'None'}</td>
                    <td className="p-2">
                      <span>{source.fetchStatus ?? 'Not fetched'}</span>
                      {source.resolvedSha && <code className="block">{source.resolvedSha}</code>}
                      {source.fetchedAt && <span className="block">{when(source.fetchedAt)}</span>}
                      {source.fetchStatus === 'failed' && source.lastError && (
                        <InlineMarkdown className="text-sm text-red-300" body={source.lastError} />
                      )}
                    </td>
                    <td className="p-2">
                      {sources.writable && (
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                              !sources.fetchConfigured ||
                              source.kind !== 'git' ||
                              sourcePending.has(source.id) ||
                              source.fetchStatus === 'queued' ||
                              source.fetchStatus === 'fetching'
                            }
                            title={
                              source.kind === 'registry'
                                ? 'Registry fetch requires rebuildable sources and is unavailable.'
                                : !sources.fetchConfigured
                                  ? 'Set HAIVE_OWN_MODULES_HOST_DIR to enable Fetch.'
                                  : undefined
                            }
                            onClick={() => void fetchSource(source.id, false)}
                          >
                            Fetch
                          </Button>
                          {source.kind === 'git' && source.resolvedSha && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={
                                !sources.fetchConfigured ||
                                sourcePending.has(source.id) ||
                                source.fetchStatus === 'queued' ||
                                source.fetchStatus === 'fetching'
                              }
                              onClick={() => void fetchSource(source.id, true)}
                            >
                              Refresh
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                              sourcePending.has(source.id) ||
                              source.fetchStatus === 'queued' ||
                              source.fetchStatus === 'fetching'
                            }
                            onClick={() => setSourceTarget({ mode: 'edit', source })}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={
                              sourcePending.has(source.id) ||
                              source.fetchStatus === 'queued' ||
                              source.fetchStatus === 'fetching'
                            }
                            onClick={() => setSourceTarget({ mode: 'delete', source })}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {sourceTarget && (
        <ModuleSourceDialog
          key={sourceTarget.source?.id ?? 'add'}
          target={sourceTarget}
          onClose={() => setSourceTarget((current) => (current === sourceTarget ? null : current))}
          onSaved={() => void loadSources()}
        />
      )}
      {data && <ModuleSkippedSeeds rows={data.modules.rows} />}
      <ModuleTasksOpenDialog
        key={blocked?.moduleId ?? 'closed'}
        onDrained={(result) => {
          setNotice(
            result.warning ??
              `Drain requested for ${blocked?.moduleId}. Its existing tasks can finish; unrelated work continues.`,
          );
          setBlocked(null);
          void load();
        }}
        blocked={blocked}
        onClose={() => setBlocked(null)}
        onDone={turnedOff}
      />
      <ModuleTeardownDialog
        moduleId={tearingDown}
        onClose={() => setTearingDown(null)}
        onDone={tornDown}
      />
      <ModulePurgeDialog target={purging} onClose={() => setPurging(null)} onDone={purged} />
    </div>
  );
}
