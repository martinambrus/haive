'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWebSocketUrl } from '@/lib/api-client';

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
}

/**
 * Embedded noVNC view of the headed Chrome running on the DDEV runner's
 * virtual desktop (browser-testing interactive mode). The api bridges
 * RFB-over-WebSocket at /browser-vnc/<taskId> to the runner's VNC port over the
 * internal sandbox network. The user can watch the agent drive the browser and
 * click things agents can't reach (native Chrome popups). noVNC is imported
 * lazily in the browser only — it touches window at module load.
 */
export function BrowserVncPanel({ taskId, title, autoCollapse }: BrowserVncPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState<VncState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<{ disconnect(): void } | null>(null);
  // Auto-reconnect bookkeeping (see MAX_CONNECT_RETRIES): connectedRef tells a
  // dropped live session apart from a not-yet-ready runtime; the timer holds the
  // pending reconnect; connectRef lets the disconnect handler call the latest
  // connect() without a dependency cycle.
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});

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
        // A live session that dropped → go idle. Never reached 'connected' → the
        // runtime is still coming up (the api gates the bridge until DDEV/app is
        // ready), so retry quietly until it's up or the cap is hit.
        if (connectedRef.current) {
          connectedRef.current = false;
          setState('idle');
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
      rfbRef.current = rfb;
    } catch (err) {
      setMessage((err as Error).message ?? 'Failed to load the VNC client');
      setState('error');
    }
  }, [taskId]);
  connectRef.current = connect;

  const retry = useCallback(() => {
    retriesRef.current = 0;
    setMessage(null);
    void connect();
  }, [connect]);

  useEffect(() => {
    if (expanded && state === 'idle' && !rfbRef.current) void connect();
  }, [expanded, state, connect]);

  useEffect(() => () => disconnect(), [disconnect]);

  // Collapse + disconnect once the owning step finishes (e.g. 08a after the
  // workflow moves on), so it doesn't hold a redundant VNC session open behind
  // later steps. Fires once on the false→true edge; re-opening stays manual.
  useEffect(() => {
    if (autoCollapse) {
      disconnect();
      setExpanded(false);
    }
  }, [autoCollapse, disconnect]);

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
        <div className="flex gap-2">
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
