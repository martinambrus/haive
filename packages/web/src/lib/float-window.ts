/** Geometry and persistence for a detachable ("popped out") panel window.
 *
 *  Pure arithmetic only — no React, no DOM. The hook (`use-float-window`) owns the
 *  pointer plumbing and this module owns the numbers, so the parts that are easy to
 *  get wrong (a window dragged off-screen, an edge resize that drags the pinned edge
 *  along, a rect saved on a big monitor reopened on a laptop) are unit-testable.
 */

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which edge or corner a resize is driven from. The pinned edge is the opposite one. */
export type FloatEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Below this the panel header and its buttons stop fitting on one line. */
export const MIN_W = 360;
export const MIN_H = 260;

const MARGIN = 24;
const MAX_DEFAULT_W = 880;
const MAX_DEFAULT_H = 560;

/** First pop-out placement: bottom-right anchored, big enough to test in, small enough
 *  to leave the terminal it floats over readable — which is the whole point of popping
 *  out rather than maximizing. */
export function defaultRect(vw: number, vh: number): FloatRect {
  const w = Math.min(MAX_DEFAULT_W, Math.max(MIN_W, vw - MARGIN * 2));
  const h = Math.min(MAX_DEFAULT_H, Math.max(MIN_H, vh - MARGIN * 2));
  return clampRect({ x: vw - w - MARGIN, y: vh - h - MARGIN, w, h }, vw, vh);
}

/** Size floored at MIN_*, capped at the viewport; position pinned so the whole window
 *  — its drag handle above all — stays reachable. Applied on every drag, resize, restore
 *  and viewport resize. */
export function clampRect(r: FloatRect, vw: number, vh: number): FloatRect {
  const w = Math.min(Math.max(r.w, MIN_W), Math.max(vw, MIN_W));
  const h = Math.min(Math.max(r.h, MIN_H), Math.max(vh, MIN_H));
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, 0), Math.max(vw - w, 0)),
    y: Math.min(Math.max(r.y, 0), Math.max(vh - h, 0)),
  };
}

/** Drag: same size, new origin. */
export function moveRect(
  start: FloatRect,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): FloatRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);
}

/** Resize from one edge/corner with the OPPOSITE edge pinned. The size is resolved and
 *  bounded first, then the origin is derived from it — deriving the origin from the raw
 *  pointer delta instead would drag the pinned edge across the screen as soon as the
 *  drag pushes past MIN_W/MIN_H or past the viewport. */
export function resizeRect(
  start: FloatRect,
  edge: FloatEdge,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): FloatRect {
  const west = edge.includes('w');
  const north = edge.includes('n');
  let w = start.w;
  let h = start.h;
  if (edge.includes('e')) w = Math.min(start.w + dx, vw - start.x);
  if (west) w = Math.min(start.w - dx, start.x + start.w);
  if (edge.includes('s')) h = Math.min(start.h + dy, vh - start.y);
  if (north) h = Math.min(start.h - dy, start.y + start.h);
  w = Math.min(Math.max(w, MIN_W), Math.max(vw, MIN_W));
  h = Math.min(Math.max(h, MIN_H), Math.max(vh, MIN_H));
  return clampRect(
    {
      w,
      h,
      x: west ? start.x + (start.w - w) : start.x,
      y: north ? start.y + (start.h - h) : start.y,
    },
    vw,
    vh,
  );
}

export interface FloatState {
  detached: boolean;
  rect: FloatRect | null;
}

function isRect(v: unknown): v is FloatRect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (['x', 'y', 'w', 'h'] as const).every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k]),
  );
}

/** Read a persisted pop-out state. Same rule as `usePersistedToggle`: an absent (or
 *  unreadable) key means "the user never popped this panel out", never a stored `false`.
 *  Anything malformed is discarded rather than half-applied. */
export function readFloatState(key: string | null): FloatState | null {
  if (key === null || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { detached, rect } = parsed as { detached?: unknown; rect?: unknown };
    if (typeof detached !== 'boolean') return null;
    return { detached, rect: isRect(rect) ? rect : null };
  } catch {
    return null;
  }
}

export function writeFloatState(key: string | null, state: FloatState): void {
  if (key === null || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // private-mode quota etc. — keep the in-memory state.
  }
}
