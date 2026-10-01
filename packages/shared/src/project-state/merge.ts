import { sameValue, sortedSet } from './canonical.js';
import { normalizeProjectState } from './codec.js';
import { bundleFileName, claimFileName } from './names.js';
import {
  SET_SETTINGS,
  type ProjectEnvironment,
  type ProjectRender,
  type ProjectStateBundle,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from './record.js';

/** A unit both sides changed since their base, differently. Absent sides are `undefined`. */
export interface ProjectStateConflict {
  /** The unit's file, with `#key` for a key of a project file. */
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

export interface ProjectStateMerge {
  /** The local value stands for every conflicted unit until a person answers it. */
  merged: ProjectStateRecord;
  conflicts: ProjectStateConflict[];
  /** Units a first import (no base) took from incoming over a different local value. */
  overwritten: string[];
}

export interface ProjectStateMergeInput {
  /** The record at the last head both sides shared; null when there is none (a first import). */
  base: ProjectStateRecord | null;
  local: ProjectStateRecord;
  incoming: ProjectStateRecord;
  /** The normalised hash of the bytes at a claimed path, null when nothing is there. A claim both
   *  sides changed is settled by the bytes: the side whose `writtenHash` they hold wins. */
  diskHash?: (path: string) => string | null;
}

interface Outcome {
  hasBase: boolean;
  conflicts: ProjectStateConflict[];
  overwritten: string[];
}

function mergeUnit<T>(
  unit: string,
  base: T | undefined,
  local: T | undefined,
  incoming: T | undefined,
  out: Outcome,
): T | undefined {
  if (!out.hasBase) {
    if (incoming === undefined) return local;
    if (local !== undefined && !sameValue(local, incoming)) out.overwritten.push(unit);
    return incoming;
  }
  if (sameValue(local, incoming)) return local;
  if (sameValue(base, local)) return incoming;
  if (sameValue(base, incoming)) return local;
  out.conflicts.push({ unit, base, local, incoming });
  return local;
}

/** A set never conflicts: each member moves as the side that changed it says. With no base the
 *  sides are joined, since a member is an addition and dropping one would undo a choice. */
function mergeMembers(
  base: readonly string[] | undefined,
  local: readonly string[],
  incoming: readonly string[],
  hasBase: boolean,
): string[] {
  if (!hasBase) return sortedSet([...local, ...incoming]);
  const inBase = new Set(base ?? []);
  const inLocal = new Set(local);
  const inIncoming = new Set(incoming);
  return sortedSet([...inBase, ...inLocal, ...inIncoming]).filter((m) => {
    if (inLocal.has(m) === inIncoming.has(m)) return inLocal.has(m);
    return inBase.has(m) === inLocal.has(m) ? inIncoming.has(m) : inLocal.has(m);
  });
}

function mergeSetValue(
  unit: string,
  base: unknown,
  local: unknown,
  incoming: unknown,
  out: Outcome,
): unknown {
  const isList = (v: unknown): v is string[] => Array.isArray(v);
  if (isList(local) && isList(incoming) && (base === undefined || isList(base))) {
    return mergeMembers(base as string[] | undefined, local, incoming, out.hasBase);
  }
  return mergeUnit(unit, base, local, incoming, out);
}

/** Key by key while both sides hold the file; as one unit when a side has none. */
function mergeObjectFile<T extends object>(
  file: string,
  base: T | null | undefined,
  local: T | null,
  incoming: T | null,
  out: Outcome,
): T | null {
  if (local === null || incoming === null) {
    return (
      mergeUnit(file, base ?? undefined, local ?? undefined, incoming ?? undefined, out) ?? null
    );
  }
  const keys = new Set([
    ...Object.keys(local),
    ...Object.keys(incoming),
    ...Object.keys(base ?? {}),
  ]);
  const merged: Record<string, unknown> = {};
  for (const key of [...keys].sort()) {
    const value = mergeUnit(
      `${file}#${key}`,
      (base as Record<string, unknown> | null | undefined)?.[key],
      (local as Record<string, unknown>)[key],
      (incoming as Record<string, unknown>)[key],
      out,
    );
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}

function mergeKeyed<T>(
  keyOf: (item: T) => string,
  unitOf: (key: string) => string,
  base: readonly T[] | null,
  local: readonly T[],
  incoming: readonly T[],
  out: Outcome,
  settle?: (key: string, local: T | undefined, incoming: T | undefined) => T | undefined | null,
): T[] {
  const index = (items: readonly T[]) => new Map(items.map((item) => [keyOf(item), item]));
  const b = index(base ?? []);
  const l = index(local);
  const i = index(incoming);
  const merged: T[] = [];
  for (const key of sortedSet([...b.keys(), ...l.keys(), ...i.keys()])) {
    const bv = b.get(key);
    const lv = l.get(key);
    const iv = i.get(key);
    const changedBoth =
      out.hasBase && !sameValue(lv, iv) && !sameValue(bv, lv) && !sameValue(bv, iv);
    // null from `settle` means it could not decide, which is a conflict like any other.
    const settled = changedBoth && settle ? settle(key, lv, iv) : null;
    const value = settled !== null ? settled : mergeUnit(unitOf(key), bv, lv, iv, out);
    if (value !== undefined) merged.push(value);
  }
  return merged;
}

/** Three-way merge of a record, unit by unit: one side changed it → that side; both identically →
 *  either; both differently → a conflict, the local value standing meanwhile. */
export function mergeProjectState(input: ProjectStateMergeInput): ProjectStateMerge {
  const base = input.base && normalizeProjectState(input.base);
  const local = normalizeProjectState(input.local);
  const incoming = normalizeProjectState(input.incoming);
  const { diskHash } = input;
  const out: Outcome = { hasBase: base !== null, conflicts: [], overwritten: [] };

  const environment = mergeObjectFile<ProjectEnvironment>(
    'project/environment.json',
    base?.environment,
    local.environment,
    incoming.environment,
    out,
  );
  const render = mergeObjectFile<ProjectRender>(
    'project/render.json',
    base?.render,
    local.render,
    incoming.render,
    out,
  );
  const cli = mergeMembers(base?.cli, local.cli, incoming.cli, out.hasBase);

  const settings: Record<string, unknown> = {};
  const names = sortedSet([
    ...Object.keys(base?.settings ?? {}),
    ...Object.keys(local.settings),
    ...Object.keys(incoming.settings),
  ]);
  for (const name of names) {
    const unit = `settings/${name}.json`;
    const b = base?.settings[name];
    const value = SET_SETTINGS.has(name)
      ? mergeSetValue(unit, b, local.settings[name], incoming.settings[name], out)
      : mergeUnit(unit, b, local.settings[name], incoming.settings[name], out);
    if (value !== undefined) settings[name] = value;
  }

  const holds = (claim: ProjectStateClaim | undefined, bytes: string | null): boolean =>
    claim === undefined ? bytes === null : claim.writtenHash === bytes;
  const claims = mergeKeyed<ProjectStateClaim>(
    (c) => c.path,
    claimFileName,
    base?.claims ?? null,
    local.claims,
    incoming.claims,
    out,
    diskHash
      ? (path, l, i) => {
          const bytes = diskHash(path);
          if (holds(l, bytes) && !holds(i, bytes)) return l;
          if (holds(i, bytes) && !holds(l, bytes)) return i;
          return null;
        }
      : undefined,
  );
  const bundles = mergeKeyed<ProjectStateBundle>(
    (b) => b.source,
    bundleFileName,
    base?.bundles ?? null,
    local.bundles,
    incoming.bundles,
    out,
  );

  return {
    merged: normalizeProjectState({ environment, render, cli, settings, claims, bundles }),
    conflicts: out.conflicts,
    overwritten: out.overwritten,
  };
}
