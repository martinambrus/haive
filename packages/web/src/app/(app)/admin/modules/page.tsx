'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { ModuleDiffRow, ModuleState } from '@haive/shared/modularity';
import {
  getModulesLoaded,
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
import { Badge, FormError } from '@/components/ui';

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
