/** The unit of the whole render file; a key of it is `<RENDER_UNIT>#<key>`. */
export const RENDER_UNIT = 'project/render.json';

export const isRenderUnit = (unit: string): boolean =>
  unit === RENDER_UNIT || unit.startsWith(`${RENDER_UNIT}#`);

/** A conflict side as the `project_state_conflicts` columns hold it: `{ v }`, so a JSON null is a
 *  value, and NULL for a side that has no such unit. */
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
    key: row.unit.includes('#') ? row.unit.slice(row.unit.indexOf('#') + 1) : null,
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
