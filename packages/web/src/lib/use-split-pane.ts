'use client';

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_SPLIT_STATE,
  paneRatioFromPointer,
  readSplitState,
  writeSplitState,
  type PaneSide,
  type SplitState,
} from './split-pane';
import type { PointerHandlers } from './use-float-window';

export interface SplitPaneApi {
  split: boolean;
  /** Fraction of the viewport width taken by the text column. */
  ratio: number;
  /** Which side the text column sits on. */
  side: PaneSide;
  enter: () => void;
  exit: () => void;
  moveTo: (side: PaneSide) => void;
  /** Spread on the divider between the browser and the text column. */
  dividerHandlers: PointerHandlers;
}

/**
 * Split view state: the browser filling most of the viewport with the agent's prose in
 * a resizable column beside it, plus the divider drag that repartitions the two.
 *
 * Like `useFloatWindow`, nothing here moves an element in the React tree — the panel
 * places its existing children into grid areas, so the noVNC container survives the
 * mode switch. `storageKey === null` disables persistence.
 */
export function useSplitPane(storageKey: string | null): SplitPaneApi {
  const [state, setState] = useState<SplitState>(
    () => readSplitState(storageKey) ?? DEFAULT_SPLIT_STATE,
  );
  // The divider's handlers are stable closures — they read the live side/ratio here
  // rather than from the render that created them.
  const stateRef = useRef<SplitState>(state);
  stateRef.current = state;
  const draggingRef = useRef(false);

  const apply = useCallback(
    (next: SplitState, persist: boolean) => {
      stateRef.current = next;
      setState(next);
      if (persist) writeSplitState(storageKey, next);
    },
    [storageKey],
  );

  const enter = useCallback(() => apply({ ...stateRef.current, split: true }, true), [apply]);

  const exit = useCallback(() => apply({ ...stateRef.current, split: false }, true), [apply]);

  const moveTo = useCallback(
    (side: PaneSide) => apply({ ...stateRef.current, side }, true),
    [apply],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    // Capture, for the same reason the pop-out drag does: a divider drag that crosses
    // the noVNC canvas must not be delivered to the browser under test.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      const current = stateRef.current;
      apply(
        {
          ...current,
          ratio: paneRatioFromPointer(e.clientX, window.innerWidth, current.side),
        },
        false,
      );
    },
    [apply],
  );

  // Persist once the drag ends, not on every pointermove.
  const end = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      writeSplitState(storageKey, stateRef.current);
    },
    [storageKey],
  );

  return {
    split: state.split,
    ratio: state.ratio,
    side: state.side,
    enter,
    exit,
    moveTo,
    dividerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    },
  };
}
