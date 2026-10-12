/** The unit of the whole render file; a key of it is `<RENDER_UNIT>#<key>`. */
export const RENDER_UNIT = 'project/render.json';

export const isRenderUnit = (unit: string): boolean =>
  unit === RENDER_UNIT || unit.startsWith(`${RENDER_UNIT}#`);

/** The unit of the question about an imported RTK-off this install never applied; the file does not
 *  exist, it only names the setting. */
export const RTK_ENABLED_UNIT = 'settings/rtk-enabled.json';

/** The unit of one artifact claim: `claimFileName(path)`, the claim's file in the record. */
export const isClaimUnit = (unit: string): boolean =>
  /^artifacts\/[^/]+~[0-9a-f]{32}\.json$/.test(unit);

export const isConflictUnit = (unit: string): boolean =>
  isRenderUnit(unit) || isClaimUnit(unit) || unit === RTK_ENABLED_UNIT;

/** A conflict side as the `project_state_conflicts` columns hold it: `{ v }`, so a JSON null is a
 *  value, and NULL for a side that has no such unit. */
export const CONFLICT_KEY_LABELS: Readonly<Record<string, string>> = {
  projectInfo: 'Project details',
  framework: 'Framework',
  acceptedAgentIds: 'Accepted agents',
  customAgentSpecs: 'Custom agents',
};

/** What a person calls the setting a conflict unit holds, rather than its storage path. A claim
 *  unit names no path itself, so `claimPath` (read from a side) says which file it is about. */
export function conflictUnitLabel(unit: string, claimPath?: string | null): string {
  if (unit === RTK_ENABLED_UNIT) return 'RTK command compression';
  if (isClaimUnit(unit)) return `the claim for ${claimPath ?? 'a generated file'}`;
  if (unit === RENDER_UNIT) return 'The whole project record file';
  const key = unit.startsWith(`${RENDER_UNIT}#`) ? unit.slice(RENDER_UNIT.length + 1) : unit;
  return CONFLICT_KEY_LABELS[key] ?? key;
}

export const conflictSide = (value: unknown): { v: unknown } | null =>
  value === undefined ? null : { v: value };

export const conflictSideValue = (side: unknown): unknown =>
  side === null || side === undefined ? undefined : (side as { v: unknown }).v;

export const PROJECT_STATE_ANSWERS = ['keep_mine', 'take_theirs'] as const;
export type ProjectStateAnswer = (typeof PROJECT_STATE_ANSWERS)[number];

export type ConflictSideBody = { present: false } | { present: true; value: unknown };

/** A conflict row as the api serves it: a side is its value, or marked absent where this unit has none. */
export interface ProjectStateConflictBody {
  id: string;
  unit: string;
  /** The render key the unit names; null for the whole file. */
  key: string | null;
  base: ConflictSideBody;
  local: ConflictSideBody;
  incoming: ConflictSideBody;
  detectedAt: string;
  resolution: string | null;
  resolvedAt: string | null;
}

const sideBody = (side: unknown): ConflictSideBody =>
  side === null || side === undefined
    ? { present: false }
    : { present: true, value: (side as { v: unknown }).v };

export function conflictBody(row: {
  id: string;
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
  detectedAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
}): ProjectStateConflictBody {
  return {
    id: row.id,
    unit: row.unit,
    key:
      row.unit.includes('#') && !isClaimUnit(row.unit)
        ? row.unit.slice(row.unit.indexOf('#') + 1)
        : null,
    base: sideBody(row.base),
    local: sideBody(row.local),
    incoming: sideBody(row.incoming),
    detectedAt: row.detectedAt.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export interface ProjectStateResolvePayload {
  repositoryId: string;
  userId: string;
  conflictId: string;
  answer: ProjectStateAnswer;
}

/** `settled` is a row already closed by a different answer, or by the two installs agreeing. */
export type ProjectStateResolveResult =
  | { kind: 'resolved'; conflict: ProjectStateConflictBody; written: string[] }
  | { kind: 'not_found' }
  | { kind: 'settled'; resolution: string }
  | { kind: 'busy' }
  | { kind: 'moved' }
  | { kind: 'no_local' }
  | { kind: 'invalid' };
