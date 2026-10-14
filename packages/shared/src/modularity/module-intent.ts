export const MODULE_STATES = [
  'loaded',
  'missing',
  'api-only',
  'worker-only',
  'unrecorded',
  'unknown',
] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export interface ModuleIntentRow {
  moduleId: string;
  name: string;
  source: string;
  installedVersion: string;
  entitlementId: string | null;
  lastLoadedAt: Date | string;
  missingAt: Date | string | null;
  deactivatedAt: Date | string | null;
}

export interface ModuleDiffRow {
  id: string;
  name: string | null;
  source: string | null;
  entitlementId: string | null;
  state: ModuleState;
  rowVersion: string | null;
  apiVersion: string | null;
  workerVersion: string | null;
  versionDrift: boolean;
  lastLoadedAt: string | null;
  missingAt: string | null;
  deactivatedAt: string | null;
}

export interface ModuleDiff {
  workerAt: string | null;
  rows: ModuleDiffRow[];
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : typeof value === 'string' ? value : value.toISOString();

function readWorkerReport(raw: unknown): { at: string | null; versions: Map<string, string> } {
  const versions = new Map<string, string>();
  if (typeof raw !== 'object' || raw === null) return { at: null, versions };
  const { at, modules } = raw as { at?: unknown; modules?: unknown };
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !Array.isArray(modules)) {
    return { at: null, versions };
  }
  for (const entry of modules as unknown[]) {
    const { id, version } = (entry ?? {}) as { id?: unknown; version?: unknown };
    if (typeof id !== 'string' || typeof version !== 'string')
      return { at: null, versions: new Map() };
    versions.set(id, version);
  }
  return { at, versions };
}

/**
 * One row per module id seen by the intent table, the api or the worker report. `missing` is the
 * table's structural marker; a recorded row that neither process now loads is shown missing too,
 * and without a valid worker report a recorded row's worker side is `unknown`.
 */
export function diffModuleIntent(
  intentRows: readonly ModuleIntentRow[],
  apiLoaded: readonly { id: string; version: string }[],
  workerReport: unknown,
): ModuleDiff {
  const worker = readWorkerReport(workerReport);
  const rows = new Map(intentRows.map((r) => [r.moduleId, r]));
  const apiVersions = new Map(apiLoaded.map((m) => [m.id, m.version]));
  const ids = new Set([...rows.keys(), ...apiVersions.keys(), ...worker.versions.keys()]);

  const out: ModuleDiffRow[] = [...ids].sort().map((id) => {
    const row = rows.get(id) ?? null;
    const apiVersion = apiVersions.get(id) ?? null;
    const workerVersion = worker.versions.get(id) ?? null;
    const inApi = apiVersion !== null;
    const inWorker = workerVersion !== null;
    let state: ModuleState;
    if (row === null) state = inApi ? 'unrecorded' : 'worker-only';
    else if (row.missingAt !== null) state = 'missing';
    else if (worker.at === null) state = 'unknown';
    else if (!inApi && !inWorker) state = 'missing';
    else if (inApi && inWorker) state = 'loaded';
    else state = inApi ? 'api-only' : 'worker-only';
    const rowVersion = row?.installedVersion ?? null;
    const seen = [rowVersion, apiVersion, workerVersion].filter((v): v is string => v !== null);
    return {
      id,
      name: row?.name ?? null,
      source: row?.source ?? null,
      entitlementId: row?.entitlementId ?? null,
      state,
      rowVersion,
      apiVersion,
      workerVersion,
      versionDrift: new Set(seen).size > 1,
      lastLoadedAt: row ? iso(row.lastLoadedAt) : null,
      missingAt: row ? iso(row.missingAt) : null,
      deactivatedAt: row ? iso(row.deactivatedAt) : null,
    };
  });
  return { workerAt: worker.at, rows: out };
}
