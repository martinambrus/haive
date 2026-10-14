'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ModuleDiffRow, ModuleState } from '@haive/shared/modularity';
import {
  getModulesLoaded,
  moduleOpenTasks,
  patchModuleActive,
  type ApiError,
  type ModuleOpenTask,
  type ModulesLoadedResponse,
  type ModuleTeardownResponse,
} from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import { ModuleActiveCell } from '@/components/module-active-cell';
import { ModuleTasksOpenDialog } from '@/components/module-tasks-open-dialog';
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
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ moduleId: string; tasks: ModuleOpenTask[] } | null>(
    null,
  );
  const [tearingDown, setTearingDown] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getModulesLoaded());
      setError(null);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to load modules');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: ModuleDiffRow) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await patchModuleActive(row.id, row.deactivatedAt !== null);
      await load();
      router.refresh();
    } catch (err) {
      const tasks = moduleOpenTasks(err as ApiError);
      if (tasks.length > 0) setBlocked({ moduleId: row.id, tasks });
      else setError((err as ApiError).message ?? 'Failed to update the module');
    } finally {
      setBusy(false);
    }
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
          className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
        >
          {notice}
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
                      busy={busy}
                      onToggle={() => void toggle(row)}
                      onTeardown={() => setTearingDown(row.id)}
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
      <ModuleTasksOpenDialog blocked={blocked} onClose={() => setBlocked(null)} />
      <ModuleTeardownDialog
        moduleId={tearingDown}
        onClose={() => setTearingDown(null)}
        onDone={tornDown}
      />
    </div>
  );
}
