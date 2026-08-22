'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  clampRect,
  defaultRect,
  moveRect,
  readFloatState,
  resizeRect,
  writeFloatState,
  type FloatEdge,
  type FloatRect,
  type FloatState,
} from './float-window';

interface PointerHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
}

export interface FloatGrip {
  edge: FloatEdge;
  className: string;
  handlers: PointerHandlers;
}

export interface FloatWindowApi {
  detached: boolean;
  /** Pop the panel out into a floating window (persists). */
  detach: () => void;
  /** Put it back inline (persists — an explicit user action). */
  dock: () => void;
  /** Put it back inline WITHOUT persisting — for programmatic docking (the session the
   *  panel showed has ended), which must not overwrite the user's own pop-out choice. */
  dockAuto: () => void;
  /** Inline style for the panel root while detached; undefined when docked. */
  style: CSSProperties | undefined;
  /** Spread on the panel header — it doubles as the floating window's title bar. */
  headerHandlers: PointerHandlers;
  /** Resize handles to render inside the panel root while detached. */
  grips: FloatGrip[];
}

/** Corners carry z-10 so they win the hit test over the edges they overlap. */
const GRIP_CLASSES: Record<FloatEdge, string> = {
  n: 'absolute inset-x-0 top-0 h-1.5 cursor-ns-resize touch-none',
  s: 'absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize touch-none',
  e: 'absolute inset-y-0 right-0 w-1.5 cursor-ew-resize touch-none',
  w: 'absolute inset-y-0 left-0 w-1.5 cursor-ew-resize touch-none',
  ne: 'absolute right-0 top-0 z-10 h-3 w-3 cursor-nesw-resize touch-none',
  nw: 'absolute left-0 top-0 z-10 h-3 w-3 cursor-nwse-resize touch-none',
  se: 'absolute bottom-0 right-0 z-10 h-3 w-3 cursor-nwse-resize touch-none',
  sw: 'absolute bottom-0 left-0 z-10 h-3 w-3 cursor-nesw-resize touch-none',
};

const EDGES = Object.keys(GRIP_CLASSES) as FloatEdge[];

interface DragSession {
  /** null = dragging the whole window by its title bar. */
  edge: FloatEdge | null;
  startRect: FloatRect;
  px: number;
  py: number;
}

/**
 * Drives a panel that can be "popped out" of the page flow into a floating window the
 * user drags by its header and resizes from its border.
 *
 * The panel element is NEVER moved in the React tree — detaching only switches its
 * className to `position: fixed` and feeds it `style`. That matters for a panel holding
 * a live session (the VNC canvas): a portal, or a wrapper whose JSX shape changes with
 * the flag, would unmount the subtree and kill it.
 *
 * `storageKey === null` disables persistence (in-memory only), matching
 * `usePersistedToggle`.
 */
export function useFloatWindow(storageKey: string | null): FloatWindowApi {
  const [state, setState] = useState<FloatState>(
    () => readFloatState(storageKey) ?? { detached: false, rect: null },
  );
  // Pointer handlers are stable closures; they read the live rect from here rather than
  // from a captured render's state.
  const rectRef = useRef<FloatRect | null>(state.rect);
  rectRef.current = state.rect;
  const dragRef = useRef<DragSession | null>(null);

  const apply = useCallback(
    (next: FloatState, persist: boolean) => {
      rectRef.current = next.rect;
      setState(next);
      if (persist) writeFloatState(storageKey, next);
    },
    [storageKey],
  );

  const detach = useCallback(() => {
    const rect = clampRect(
      rectRef.current ?? defaultRect(window.innerWidth, window.innerHeight),
      window.innerWidth,
      window.innerHeight,
    );
    apply({ detached: true, rect }, true);
  }, [apply]);

  const dock = useCallback(() => apply({ detached: false, rect: rectRef.current }, true), [apply]);

  const dockAuto = useCallback(
    () => apply({ detached: false, rect: rectRef.current }, false),
    [apply],
  );

  // A rect restored from localStorage was measured against whatever viewport the user
  // had then — clamp it to this one so a window saved on a big monitor cannot open
  // off-screen on a laptop. Mount-time only: the state initializer has no viewport.
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current || !state.detached) return;
    reconciled.current = true;
    apply(
      {
        detached: true,
        rect: clampRect(
          state.rect ?? defaultRect(window.innerWidth, window.innerHeight),
          window.innerWidth,
          window.innerHeight,
        ),
      },
      false,
    );
  }, [state.detached, state.rect, apply]);

  useEffect(() => {
    if (!state.detached) return;
    const onResize = () => {
      const rect = rectRef.current;
      if (rect)
        apply(
          { detached: true, rect: clampRect(rect, window.innerWidth, window.innerHeight) },
          false,
        );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [state.detached, apply]);

  const begin = useCallback(
    (edge: FloatEdge | null) => (e: ReactPointerEvent<HTMLElement>) => {
      if (!state.detached || e.button !== 0) return;
      // The header carries the panel's own controls (Paste / Fullscreen / Dock / Hide) —
      // a click on one of those is not a drag.
      if (edge === null && (e.target as HTMLElement).closest('button, a, input, select')) return;
      const startRect = rectRef.current;
      if (!startRect) return;
      dragRef.current = { edge, startRect, px: e.clientX, py: e.clientY };
      // Capture so every later pointer event is delivered to this element. Without it a
      // drag crossing the noVNC canvas injects mouse events into the remote browser.
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [state.detached],
  );

  const move = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.px;
      const dy = e.clientY - drag.py;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect =
        drag.edge === null
          ? moveRect(drag.startRect, dx, dy, vw, vh)
          : resizeRect(drag.startRect, drag.edge, dx, dy, vw, vh);
      apply({ detached: true, rect }, false);
    },
    [apply],
  );

  // Persist once the gesture ends, not on every pointermove.
  const end = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      writeFloatState(storageKey, { detached: true, rect: rectRef.current });
    },
    [storageKey],
  );

  const handlersFor = useCallback(
    (edge: FloatEdge | null): PointerHandlers => ({
      onPointerDown: begin(edge),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    }),
    [begin, move, end],
  );

  return {
    detached: state.detached,
    detach,
    dock,
    dockAuto,
    style:
      state.detached && state.rect
        ? { left: state.rect.x, top: state.rect.y, width: state.rect.w, height: state.rect.h }
        : undefined,
    headerHandlers: handlersFor(null),
    grips: EDGES.map((edge) => ({
      edge,
      className: GRIP_CLASSES[edge],
      handlers: handlersFor(edge),
    })),
  };
}
