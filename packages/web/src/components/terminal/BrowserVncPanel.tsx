'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWebSocketUrl } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';
import { useFloatWindow } from '@/lib/use-float-window';
import { useSplitPane } from '@/lib/use-split-pane';
import { suppressNovncCloseLog } from '@/lib/suppress-novnc-log';
import { SplitTerminalPane } from './SplitTerminalPane';

type VncState = 'idle' | 'connecting' | 'connected' | 'error';

// While the runtime cold-boots, the api gates (and may reject) the VNC bridge until it is up,
// so retry quietly up to this many times — showing a "starting…" state — before surfacing an
// error. Must cover a cold DDEV boot PLUS a first-run install (composer / site-install), which
// routinely runs past a couple of minutes: the old 24s (8×3s) gave up mid-install and forced a
// manual Retry even though the runtime came up moments later. ~3 min at 3s (the api holds each
// attempt up to its own VNC_ENSURE_TIMEOUT_MS, so a slow-but-progressing boot bridges in one
// shot without exhausting these). A genuinely stuck runtime still surfaces the Retry button.
const MAX_CONNECT_RETRIES = 60;
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
  /** The in-environment URL the embedded browser is pointed at, shown as a read-only
   *  caption so the user knows what they're testing (and can reproduce it after a
   *  restart brings a fresh desktop up). NOT a link: in VNC (non-direct) mode the app
   *  port is not published to the host, so this URL only resolves inside the environment
   *  streamed below — direct mode is the one that hands out host-openable URLs. */
  appUrl?: string | null;
  /** task_steps row id whose CLI output the split view streams beside the browser.
   *  Passing it is what OFFERS the split view: only the browser-testing step, where an
   *  agent is actually driving this browser, has prose worth watching live. Panels
   *  without it (gate 2, run_app) keep Maximize and Pop out only. */
  terminalStepRowId?: string;
}

/**
 * Embedded noVNC view of the headed Chrome running on the DDEV runner's
 * virtual desktop (browser-testing interactive mode). The api bridges
 * RFB-over-WebSocket at /browser-vnc/<taskId> to the runner's VNC port over the
 * internal sandbox network. The user can watch the agent drive the browser and
 * click things agents can't reach (native Chrome popups). noVNC is imported
 * lazily in the browser only — it touches window at module load.
 */
export function BrowserVncPanel({
  taskId,
  title,
  autoCollapse,
  persistId,
  appUrl,
  terminalStepRowId,
}: BrowserVncPanelProps) {
  // Persisted per task (when a persistId is given) so a reload restores whether this
  // panel was open. autoCollapse below is edge-guarded so it never clobbers a restore.
  const [expanded, setExpanded, setExpandedAuto] = usePersistedToggle(
    persistId ? `task-ui:${taskId}:vnc:${persistId}` : null,
    true,
  );
  const [maximized, setMaximized] = useState(false);
  // Pop-out: the panel root switches to position:fixed at a user-dragged rect and its
  // header doubles as the window's title bar, so the browser can sit beside the step's
  // terminal instead of below it. Same mounted element in both modes — see the maximize
  // note further down for why that is the constraint the whole feature turns on.
  const float = useFloatWindow(persistId ? `task-ui:${taskId}:vnc:${persistId}:float` : null);
  // Split view: browser on one side of the viewport, the agent's prose in a column on
  // the other. Offered only where a terminal was handed in, and only while the browser
  // is actually shown — a collapsed panel has nothing to split.
  const split = useSplitPane(persistId ? `task-ui:${taskId}:vnc:${persistId}:split` : null);
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
  // Mirror the autoCollapse prop into a ref so the disconnect handler (a stable closure created
  // in connect()) can read the CURRENT value: while the step is still active (autoCollapse false)
  // a live drop reconnects to re-stream the unchanged desktop; once the step finishes
  // (autoCollapse true) a drop is terminal (the runtime is being torn down).
  const autoCollapseRef = useRef(autoCollapse);

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
    // Install before the RFB below can log a benign 1006 close (idempotent) so the reconnect
    // churn doesn't pop the Next.js dev overlay as a page-level Console Error.
    suppressNovncCloseLog();
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
          // Terminal ONLY if the step already finished (autoCollapse → the runtime is being
          // torn down; reconnecting would race a gone bridge and cold-boot a completed task's
          // runtime). While the step is still active, fall through to the reconnect path below
          // to re-stream the (unchanged) desktop — a bridge drop mid-review must self-heal, not
          // give up. A successful reconnect resets retriesRef, so a session that drops every so
          // often keeps re-streaming; only genuinely-failing reconnects hit the budget below.
          if (autoCollapseRef.current) {
            liveDropRef.current = true;
            setMessage('Browser session ended.');
            setState('error');
            return;
          }
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
    autoCollapseRef.current = autoCollapse;
    // Fire only on the false→true edge (step finishing), NOT on mount — otherwise a
    // reload of an already-finished step would clobber a persisted "expanded".
    // setExpandedAuto is the ephemeral setter: the programmatic collapse stays
    // in-memory (no localStorage write), so a remount restores the open-by-default
    // fallback; only the user's toggle persists.
    if (autoCollapse && !prevAutoCollapse.current) {
      disconnect();
      setExpandedAuto(false);
      // Dock a popped-out window too, so a finished step never leaves an empty floating
      // frame over the page. dockAuto (not dock) — this is programmatic, so it must not
      // overwrite the user's own pop-out choice for the next time this panel opens.
      float.dockAuto();
    }
    prevAutoCollapse.current = autoCollapse;
  }, [autoCollapse, disconnect, setExpandedAuto, float.dockAuto]);

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

  const splitOn = split.split && !!terminalStepRowId && expanded;
  // Split and pop-out persist independently, so a reload can restore both. Split takes
  // the whole viewport, so it wins: without this the root would be the split grid while
  // the placeholder bar and the float's resize grips still rendered around it.
  const detached = float.detached && !splitOn;
  const paneOnRight = split.side === 'right';
  // Grid areas for split mode. Placing the EXISTING children by area is the whole
  // trick: wrapping the VNC body in a row to sit it next to the prose column would
  // re-create the noVNC container and drop the session, so the root becomes a grid
  // instead and nothing moves in the tree.
  const rowSpan = (row: number) => (splitOn ? { gridColumn: '1 / -1', gridRow: row } : undefined);
  const colArea = (col: number) => (splitOn ? { gridColumn: col, gridRow: 3 } : undefined);
  const enterSplit = () => {
    float.dockAuto();
    setMaximized(false);
    split.enter();
    nudgeResize();
  };

  return (
    <>
      {/* Holds the panel's place in the page flow while it floats. ALWAYS rendered
          (merely hidden when docked) so the panel root below keeps its slot index —
          a shifting slot would re-create the noVNC container and kill the session. */}
      <div
        className={
          detached
            ? 'flex items-center justify-between rounded-md border border-dashed border-neutral-700 bg-neutral-950 px-3 py-2'
            : 'hidden'
        }
      >
        <span className="text-xs text-neutral-400">
          {title ?? 'Browser (interactive validation)'} — popped out
        </span>
        <button type="button" onClick={float.dock} className="text-xs text-indigo-400 underline">
          Dock
        </button>
      </div>
      <div
        className={
          splitOn
            ? 'fixed inset-0 z-50 grid gap-1 border border-neutral-800 bg-neutral-950 p-2'
            : detached
              ? 'fixed z-50 flex flex-col gap-1 overflow-hidden rounded-md border border-neutral-700 bg-neutral-950 p-2 shadow-2xl shadow-black/60'
              : maximized
                ? 'fixed inset-0 z-50 flex flex-col gap-1 border border-neutral-800 bg-neutral-950 p-2'
                : 'flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-2'
        }
        style={
          splitOn
            ? {
                gridTemplateColumns: paneOnRight
                  ? `1fr 6px ${(split.ratio * 100).toFixed(2)}%`
                  : `${(split.ratio * 100).toFixed(2)}% 6px 1fr`,
                gridTemplateRows: 'auto auto minmax(0, 1fr)',
              }
            : float.style
        }
      >
        {/* Doubles as the floating window's title bar: the drag handlers no-op while
            docked, and skip presses that land on the buttons on the right. */}
        <div
          className={
            detached
              ? 'flex cursor-move select-none items-center justify-between'
              : 'flex items-center justify-between'
          }
          style={rowSpan(1)}
          {...float.headerHandlers}
        >
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
                {!detached && !splitOn && (
                  <button
                    type="button"
                    onClick={toggleMaximize}
                    className="text-xs text-indigo-400 underline"
                  >
                    {maximized ? 'Restore' : 'Maximize'}
                  </button>
                )}
                {!maximized && !splitOn && (
                  <button
                    type="button"
                    onClick={detached ? float.dock : float.detach}
                    title={
                      detached
                        ? 'Put the browser back inline'
                        : 'Float the browser over the page so you can watch it beside the terminal'
                    }
                    className="text-xs text-indigo-400 underline"
                  >
                    {detached ? 'Dock' : 'Pop out'}
                  </button>
                )}
                {terminalStepRowId && (
                  <button
                    type="button"
                    onClick={splitOn ? split.exit : enterSplit}
                    title={
                      splitOn
                        ? 'Put the browser back inline'
                        : "Fill the screen with the browser and stream the agent's text beside it"
                    }
                    className="text-xs text-indigo-400 underline"
                  >
                    {splitOn ? 'Exit split' : 'Split'}
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (expanded) {
                  disconnect();
                  setMaximized(false);
                  // Hiding a popped-out browser docks it: a floating frame with nothing
                  // in it is not a state worth having.
                  float.dock();
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
        {appUrl && (
          <p className="px-0.5 text-[11px] text-neutral-500" style={rowSpan(2)}>
            Testing <span className="font-mono text-neutral-400">{appUrl}</span> in the environment
            below
          </p>
        )}
        {expanded && (
          <div
            className={
              maximized || detached || splitOn
                ? 'relative min-h-0 w-full flex-1'
                : 'relative h-[480px] w-full'
            }
            style={colArea(paneOnRight ? 1 : 3)}
          >
            {/* noVNC manages its own canvas here; stays mounted across maximize and
                pop-out toggles so the RFB session survives. */}
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
        {/* Resize border. Trailing siblings, so adding them never disturbs the slots
            above — least of all the noVNC container's. */}
        {detached &&
          float.grips.map((grip) => (
            <div key={grip.edge} className={grip.className} {...grip.handlers} />
          ))}
        {/* Split view's divider and prose column — also trailing siblings; the grid
            areas above put them where they belong regardless of DOM order. */}
        {splitOn && (
          <div
            className="touch-none cursor-col-resize rounded bg-neutral-800 transition-colors hover:bg-indigo-600"
            style={{ gridColumn: 2, gridRow: 3 }}
            {...split.dividerHandlers}
          />
        )}
        {splitOn && terminalStepRowId && (
          <div className="min-h-0 min-w-0" style={colArea(paneOnRight ? 3 : 1)}>
            <SplitTerminalPane
              taskId={taskId}
              stepRowId={terminalStepRowId}
              side={split.side}
              onMove={split.moveTo}
            />
          </div>
        )}
      </div>
    </>
  );
}
