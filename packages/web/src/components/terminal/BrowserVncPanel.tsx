'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWebSocketUrl } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

type VncState = 'idle' | 'connecting' | 'connected' | 'error';

// While the runtime cold-boots, the api gates (and may reject) the VNC bridge
// until it is up, so retry quietly up to this many times — showing a "starting…"
// state — before surfacing an error.
const MAX_CONNECT_RETRIES = 8;
const RETRY_DELAY_MS = 3000;

interface BrowserVncPanelProps {
  taskId: string;
  /** Header label; defaults to the interactive-validation wording. */
  title?: string;
  /** When this flips true (e.g. the owning step finished), collapse and drop the
   *  connection so a redundant VNC session isn't held open behind later steps.
   *  The user can still re-open it. */
  autoCollapse?: boolean;
  /** Stable id (e.g. the owning step id) used to persist this panel's collapsed/
   *  expanded state per task across reloads. Omit to keep it in-memory only. */
  persistId?: string;
}

/**
 * Embedded noVNC view of the headed Chrome running on the DDEV runner's
 * virtual desktop (browser-testing interactive mode). The api bridges
 * RFB-over-WebSocket at /browser-vnc/<taskId> to the runner's VNC port over the
 * internal sandbox network. The user can watch the agent drive the browser and
 * click things agents can't reach (native Chrome popups). noVNC is imported
 * lazily in the browser only — it touches window at module load.
 */
export function BrowserVncPanel({ taskId, title, autoCollapse, persistId }: BrowserVncPanelProps) {
  // Persisted per task (when a persistId is given) so a reload restores whether this
  // panel was open. autoCollapse below is edge-guarded so it never clobbers a restore.
  const [expanded, setExpanded, setExpandedAuto] = usePersistedToggle(
    persistId ? `task-ui:${taskId}:vnc:${persistId}` : null,
    true,
  );
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState<VncState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<{
    disconnect(): void;
    clipboardPasteFrom(text: string): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
  } | null>(null);
  // Auto-reconnect bookkeeping (see MAX_CONNECT_RETRIES): connectedRef tells a
  // dropped live session apart from a not-yet-ready runtime; the timer holds the
  // pending reconnect; connectRef lets the disconnect handler call the latest
  // connect() without a dependency cycle.
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  // Set once a live session drops (most commonly the task completing and its
  // runtime being torn down). Suppresses the auto-reconnect below so we don't race
  // a gone bridge — that reconnect's rejected upgrade is what made noVNC log a
  // 1006 "Failed when connecting" console error on every completion. Cleared on an
  // explicit user reconnect (Retry / Show).
  const liveDropRef = useRef(false);

  const disconnect = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retriesRef.current = 0;
    connectedRef.current = false;
    try {
      rfbRef.current?.disconnect();
    } catch {
      /* already closed */
    }
    rfbRef.current = null;
    setState('idle');
  }, []);

  const connect = useCallback(async () => {
    if (!containerRef.current || rfbRef.current) return;
    setState('connecting');
    setMessage(null);
    try {
      // novnc 1.7.0 ships `exports: "./core/rfb.js"`, which blocks the `/core/rfb`
      // subpath import — the bare package specifier maps to that same module.
      const { default: RFB } = await import('@novnc/novnc');
      const rfb = new RFB(containerRef.current, apiWebSocketUrl(`/browser-vnc/${taskId}`));
      rfb.scaleViewport = true;
      rfb.addEventListener('connect', () => {
        connectedRef.current = true;
        retriesRef.current = 0;
        setState('connected');
      });
      rfb.addEventListener('disconnect', () => {
        rfbRef.current = null;
        // A live session that dropped → don't auto-reconnect. The runtime is
        // usually gone (the task completed and tore it down), so a reconnect just
        // races a torn-down bridge whose rejected upgrade closes 1006 mid-handshake
        // and noVNC logs "Failed when connecting" to the console (which the Next dev
        // overlay surfaces). Surface a manual Retry instead; on task completion the
        // autoCollapse effect collapses this panel a moment later anyway.
        // (Never reached 'connected' → the runtime is still coming up; the api gates
        // the bridge until DDEV/app is ready, so retry quietly until it's up or the
        // cap is hit.)
        if (connectedRef.current) {
          connectedRef.current = false;
          liveDropRef.current = true;
          setMessage('Browser session ended.');
          setState('error');
          return;
        }
        if (retriesRef.current < MAX_CONNECT_RETRIES) {
          retriesRef.current += 1;
          setState('connecting');
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => connectRef.current(), RETRY_DELAY_MS);
        } else {
          setMessage('The browser environment is taking longer than expected to start.');
          setState('error');
        }
      });
      // Clipboard sharing (remote → host): when the user copies inside the remote
      // browser, x11vnc relays the selection over RFB; mirror it into the host
      // clipboard. Best-effort — no-ops outside a secure context (navigator.clipboard
      // is undefined over plain HTTP on a non-localhost origin).
      rfb.addEventListener('clipboard', (e) => {
        const text = (e as CustomEvent<{ text?: string }>).detail?.text;
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
      });
      rfbRef.current = rfb;
    } catch (err) {
      setMessage((err as Error).message ?? 'Failed to load the VNC client');
      setState('error');
    }
  }, [taskId]);
  connectRef.current = connect;

  const retry = useCallback(() => {
    retriesRef.current = 0;
    liveDropRef.current = false;
    setMessage(null);
    void connect();
  }, [connect]);

  // Clipboard sharing (host → remote): readText() needs a user gesture + the
  // clipboard-read permission, so it's driven by the Paste button rather than synced
  // automatically. canPaste hides the button where the clipboard API is unavailable
  // (a non-secure context — plain HTTP on a non-localhost origin).
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const pasteIntoBrowser = useCallback(async () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Permission denied / no gesture — surface a hint instead of a silent no-op.
      setPasteNote('Allow clipboard access, then click Paste again');
      setTimeout(() => setPasteNote(null), 4000);
      return;
    }
    if (!text) return;
    // Load the remote clipboard, THEN inject Ctrl+V so the paste actually lands in the
    // focused remote field. clipboardPasteFrom alone only sets the remote clipboard —
    // the user would otherwise have to press Ctrl+V inside the VNC themselves, which
    // is the unreliable two-step we are replacing. The short delay lets x11vnc register
    // the cut text before the keystroke asks for it. Keysyms: 0xffe3 = Control_L, 0x76 = 'v'.
    rfb.clipboardPasteFrom(text);
    setTimeout(() => {
      const r = rfbRef.current;
      if (!r) return;
      r.sendKey(0xffe3, 'ControlLeft', true);
      r.sendKey(0x76, 'KeyV', true);
      r.sendKey(0x76, 'KeyV', false);
      r.sendKey(0xffe3, 'ControlLeft', false);
    }, 150);
  }, []);

  useEffect(() => {
    if (expanded && state === 'idle' && !rfbRef.current && !liveDropRef.current) void connect();
  }, [expanded, state, connect]);

  useEffect(() => () => disconnect(), [disconnect]);

  // Collapse + disconnect once the owning step finishes (e.g. 08a after the
  // workflow moves on), so it doesn't hold a redundant VNC session open behind
  // later steps. Fires once on the false→true edge; re-opening stays manual.
  const prevAutoCollapse = useRef(autoCollapse);
  useEffect(() => {
    // Fire only on the false→true edge (step finishing), NOT on mount — otherwise a
    // reload of an already-finished step would clobber a persisted "expanded".
    // setExpandedAuto is the ephemeral setter: the programmatic collapse stays
    // in-memory (no localStorage write), so a remount restores the open-by-default
    // fallback; only the user's toggle persists.
    if (autoCollapse && !prevAutoCollapse.current) {
      disconnect();
      setExpandedAuto(false);
    }
    prevAutoCollapse.current = autoCollapse;
  }, [autoCollapse, disconnect, setExpandedAuto]);

  // Maximize = full-page overlay in the SAME window so the user keeps testing
  // without blurring the tab (the user-active timer keeps running). The
  // container div stays the same mounted element across toggles, so the RFB
  // session survives; noVNC rescales via scaleViewport. The resize nudge prompts
  // that rescale once the container's new size has settled.
  const nudgeResize = () => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };
  const toggleMaximize = useCallback(() => {
    setMaximized((v) => !v);
    nudgeResize();
  }, []);
  const enterFullscreen = useCallback(() => {
    void containerRef.current
      ?.requestFullscreen?.()
      .then(nudgeResize)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  return (
    <div
      className={
        maximized
          ? 'fixed inset-0 z-50 flex flex-col gap-1 border border-neutral-800 bg-neutral-950 p-2'
          : 'flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-2'
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          {title ?? 'Browser (interactive validation)'}
          {state === 'connected' && <span className="ml-2 text-emerald-400">● live</span>}
          {state === 'connecting' && <span className="ml-2 text-neutral-500">starting…</span>}
        </span>
        <div className="flex items-center gap-2">
          {pasteNote && <span className="text-xs text-amber-400">{pasteNote}</span>}
          {expanded && state === 'connected' && canPaste && (
            <button
              type="button"
              onClick={() => void pasteIntoBrowser()}
              title="Paste your clipboard into the focused field in the remote browser"
              className="text-xs text-indigo-400 underline"
            >
              Paste
            </button>
          )}
          {expanded && (
            <>
              <button
                type="button"
                onClick={enterFullscreen}
                className="text-xs text-indigo-400 underline"
              >
                Fullscreen
              </button>
              <button
                type="button"
                onClick={toggleMaximize}
                className="text-xs text-indigo-400 underline"
              >
                {maximized ? 'Restore' : 'Maximize'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              if (expanded) {
                disconnect();
                setMaximized(false);
              } else {
                // Re-opening after a hide/auto-collapse → allow a fresh connect even
                // if a prior live session had dropped.
                liveDropRef.current = false;
              }
              setExpanded((v) => !v);
            }}
            className="text-xs text-indigo-400 underline"
          >
            {expanded ? 'Hide' : 'Show'} browser
          </button>
        </div>
      </div>
      {expanded && (
        <div className={maximized ? 'relative min-h-0 w-full flex-1' : 'relative h-[480px] w-full'}>
          {/* noVNC manages its own canvas here; stays mounted across maximize
              toggles so the RFB session survives. */}
          <div ref={containerRef} className="h-full w-full overflow-hidden rounded bg-black" />
          {state !== 'connected' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded bg-neutral-950/95 px-4 text-center">
              {state === 'error' ? (
                <>
                  <p className="text-sm text-amber-400">
                    {message ?? 'Could not start the browser environment.'}
                  </p>
                  <button
                    type="button"
                    onClick={retry}
                    className="text-xs text-indigo-400 underline"
                  >
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400" />
                  <p className="text-sm text-neutral-300">Starting the browser environment…</p>
                  <p className="text-xs text-neutral-500">
                    First boot can take a minute or two while DDEV builds and starts.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
