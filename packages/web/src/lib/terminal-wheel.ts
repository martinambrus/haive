import type { Terminal } from '@xterm/xterm';

/**
 * Restore mouse-wheel scrollback. xterm 6.0 rebuilt the viewport on VS Code's
 * ScrollableElement; in our embedding wheeling over the screen no longer scrolls
 * the buffer and xterm falls back to emitting cursor-key escapes — which an
 * interactive bash reads as history navigation (Up arrow) instead of showing
 * earlier output. Take over the wheel via xterm's public custom-wheel hook: in
 * the normal buffer with no mouse tracking, scroll the scrollback ourselves and
 * return false so xterm runs none of its default wheel handling (no cursor
 * keys). Defer to xterm (return true) when a full-screen app owns the wheel —
 * mouse tracking on (forwarded as mouse events) or the alternate screen
 * (vim/less/htop, where wheel-as-arrow-keys is the intended scroll). Returns a
 * disposer that restores xterm's default handler.
 */
export function attachWheelScroll(term: Terminal): () => void {
  term.attachCustomWheelEventHandler((ev) => {
    if (term.modes.mouseTrackingMode !== 'none') return true;
    if (term.buffer.active.type === 'alternate') return true;
    term.scrollLines(ev.deltaY < 0 ? -3 : 3);
    ev.preventDefault();
    return false;
  });
  return () => term.attachCustomWheelEventHandler(() => true);
}
