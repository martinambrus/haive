/** Geometry and persistence for the split view: the VNC browser on one side of the
 *  viewport, the agent's streaming prose in a narrow column on the other.
 *
 *  Pure arithmetic only, same split of duties as `float-window.ts`: the hook owns the
 *  pointer plumbing, this module owns the numbers so the clamping is unit-testable.
 */

export type PaneSide = 'left' | 'right';

/** Fraction of the viewport width taken by the TEXT column (not the browser). */
export const PANE_MIN = 0.12;
export const PANE_MAX = 0.6;
export const PANE_DEFAULT = 0.24;

export function clampPaneRatio(r: number): number {
  if (!Number.isFinite(r)) return PANE_DEFAULT;
  return Math.min(Math.max(r, PANE_MIN), PANE_MAX);
}

/** Divider drag → new text-column fraction. The column grows toward the viewport edge
 *  it is docked to, so the two sides read the pointer from opposite ends. */
export function paneRatioFromPointer(clientX: number, vw: number, side: PaneSide): number {
  if (vw <= 0) return PANE_DEFAULT;
  return clampPaneRatio(side === 'right' ? (vw - clientX) / vw : clientX / vw);
}

export interface SplitState {
  split: boolean;
  ratio: number;
  side: PaneSide;
}

export const DEFAULT_SPLIT_STATE: SplitState = {
  split: false,
  ratio: PANE_DEFAULT,
  side: 'right',
};

/** Read a persisted split state. Same rule as `readFloatState`: an absent or malformed
 *  key means "the user never used the split view", never a half-applied state. */
export function readSplitState(key: string | null): SplitState | null {
  if (key === null || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { split, ratio, side } = parsed as { split?: unknown; ratio?: unknown; side?: unknown };
    if (typeof split !== 'boolean') return null;
    return {
      split,
      ratio: typeof ratio === 'number' ? clampPaneRatio(ratio) : PANE_DEFAULT,
      side: side === 'left' || side === 'right' ? side : 'right',
    };
  } catch {
    return null;
  }
}

export function writeSplitState(key: string | null, state: SplitState): void {
  if (key === null || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // private-mode quota etc. — keep the in-memory state.
  }
}
