'use client';

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { SIDEBAR_DEFAULT_PX, widthFromPointer } from '@/lib/sidebar-geometry';

/**
 * The divider between the sidebar and the page.
 *
 * Same shape as the plan canvas's splitter: the width updates live from a REF, and the
 * write happens once on release. A `setState` updater must be pure and StrictMode invokes
 * it twice, which would fire two PATCHes per drag; a drag also fires dozens of moves, and
 * persisting each would be dozens of requests.
 */
export function SidebarResizer({
  onResize,
  onCommit,
}: {
  /** Live width during the drag — cheap state, not persisted. */
  onResize: (px: number) => void;
  /** Called once, on release. A cancelled pointer never fires pointerup and never persists. */
  onCommit: (px: number) => void;
}) {
  const dragging = useRef(false);
  const latest = useRef(SIDEBAR_DEFAULT_PX);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const px = widthFromPointer(e.clientX);
      latest.current = px;
      onResize(px);
    },
    [onResize],
  );

  const end = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, persist: boolean) => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (persist) onCommit(latest.current);
    },
    [onCommit],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onLostPointerCapture={(e) => end(e, false)}
      onDoubleClick={() => {
        latest.current = SIDEBAR_DEFAULT_PX;
        onResize(SIDEBAR_DEFAULT_PX);
        onCommit(SIDEBAR_DEFAULT_PX);
      }}
      className="w-1 shrink-0 cursor-col-resize touch-none bg-neutral-800 transition-colors hover:bg-indigo-500"
    />
  );
}
