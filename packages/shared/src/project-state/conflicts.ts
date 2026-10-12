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
