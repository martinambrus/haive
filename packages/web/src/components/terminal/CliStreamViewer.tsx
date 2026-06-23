'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { api, apiWebSocketUrl } from '@/lib/api-client';
import { attachWheelScroll } from '@/lib/terminal-wheel';
import { MarkdownView, looksLikeMarkdown } from '@/components/markdown/markdown-view';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';
type TerminalTab = 'clean' | 'raw';

interface CliStreamViewerProps {
  invocationId: string;
  taskId: string;
  /** Called when the CLI stream ends (exit frame received). The page uses
   *  this to switch back to the Steps tab automatically. */
  onExit?: (code: number) => void;
  fill?: boolean;
  /** Override the default 600px height for inline embedding. */
  height?: string;
  /** When provided, render this output statically (no WebSocket, no Cancel
   *  button). Used to replay an ended invocation's persisted stream_log from
   *  cli_invocations.stream_log without keeping a stream alive past the
   *  Redis-stream 600s expiry. */
  staticOutput?: string;
  /** Final exit code annotation for static replays (rendered in cyan after
   *  the buffered output). Ignored when staticOutput is unset. */
  staticExitCode?: number | null;
  /** Persisted model prose for the Clean tab on replay (cli_invocations.raw_output).
   *  Ignored for live runs, which accumulate prose from `text` stream frames. */
  staticCleanOutput?: string;
  /** Whether this invocation produces parsed model prose. False for
   *  subagent_sequential (its rawOutput is a JSON trace, not prose) — those
   *  panels render raw-only with no tab bar. Defaults to true. */
  cleanSupported?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;
// How long the Clean tab may stay empty during a live run before we nudge the user
// toward the Raw tab. Ollama-class models stream thinking/assistant frames (which
// land in Raw) and may not emit the first parsed `text` frame for a long time,
// leaving an empty Clean tab looking frozen even though the model is working.
const RAW_HINT_IDLE_MS = 30_000;

export function CliStreamViewer({
  invocationId,
  taskId,
  onExit,
  fill = false,
  height,
  staticOutput,
  staticExitCode,
  staticCleanOutput,
  cleanSupported = true,
}: CliStreamViewerProps) {
  const isReplay = staticOutput !== undefined;
  // Suppress the "Loading…" overlay once any byte has been written to xterm.
  // For live runs that means the first output frame; for replays it means
  // the static dump completed (an empty replay still flips this so the
  // overlay doesn't linger on a 0-byte invocation). Drives the centered
  // placeholder rendered absolutely over the terminal mount node.
  const [hasOutput, setHasOutput] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const onExitRef = useRef(onExit);

  // Tabbed view: Clean (parsed model prose) is the default; Raw is the original
  // xterm byte stream. cleanText accumulates live `text` frames; on replay the
  // Clean tab renders staticCleanOutput instead. When cleanSupported is false we
  // render raw-only (no tabs) — unchanged from the pre-tabs behavior.
  const [tab, setTab] = useState<TerminalTab>('clean');
  const [cleanText, setCleanText] = useState('');
  // Set when a live run streams raw output but produces no parsed model prose for
  // RAW_HINT_IDLE_MS; drives the Raw-tab highlight + hint while the Clean tab is up.
  const [showRawHint, setShowRawHint] = useState(false);
  const cleanScrollRef = useRef<HTMLDivElement | null>(null);
  // Refs to the live terminal + fit addon so the tab-switch effect can re-fit
  // when Raw becomes visible (xterm laid out in a display:none container keeps a
  // zero size until re-fit).
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  const cancelActiveCli = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.post(`/tasks/${taskId}/cancel-active-cli`, {});
    } catch (err) {
      setCancelError((err as Error).message ?? 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!mountRef.current) return;

    // Tracks teardown so async callbacks (deferred fit, resize, WS frames) never
    // touch the terminal after dispose. xterm throws an uncaught
    // "this._renderer.value is undefined" from its internal render path when a
    // fit/refresh/write lands on a disposed terminal.
    let disposed = false;

    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#0a0a0a',
        black: '#0a0a0a',
        brightBlack: '#525252',
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(clipboardAddon);
    termRef.current = term;
    fitRef.current = fitAddon;

    // Read-only viewer: Ctrl+C / Ctrl+Shift+C copy the current selection.
    // There is no CLI-cancel hotkey — cancelling is done via the Cancel
    // button so Ctrl+C never interferes with the standard copy shortcut.
    // (disableStdin already blocks input forwarding.)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      return true;
    });

    term.open(mountRef.current);
    const detachWheel = attachWheelScroll(term);
    let fitRaf1 = 0;
    let fitRaf2 = 0;
    fitRaf1 = requestAnimationFrame(() => {
      fitRaf2 = requestAnimationFrame(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      });
    });

    const handleResize = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
    };
    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(mountRef.current);

    // Replay path: skip WebSocket entirely. Just dump the persisted output
    // into the terminal and annotate the exit code. No keepalive, no cancel.
    if (isReplay) {
      setState('closed');
      if (staticOutput) term.write(staticOutput);
      if (typeof staticExitCode === 'number') {
        term.writeln(`\r\n\x1b[36m[CLI exited with code ${staticExitCode}]\x1b[0m`);
      }
      setHasOutput(true);
      return () => {
        disposed = true;
        cancelAnimationFrame(fitRaf1);
        cancelAnimationFrame(fitRaf2);
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        detachWheel();
        termRef.current = null;
        fitRef.current = null;
        term.dispose();
      };
    }

    const ws = new WebSocket(apiWebSocketUrl(`/cli-stream/${invocationId}`));
    setState('connecting');

    ws.onopen = () => {
      // server replays buffered chunks via XREAD from id 0 — nothing to send.
    };

    ws.onmessage = (ev) => {
      if (disposed) return;
      let parsed: { type: string; [k: string]: unknown } | null = null;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (!parsed) return;
      switch (parsed.type) {
        case 'connected':
          setState('connected');
          setErrorMsg(null);
          break;
        case 'output':
          if (typeof parsed.data === 'string') {
            // `text` frames carry the model's parsed prose for the Clean tab;
            // stdout/stderr (and legacy frames without a stream) go to xterm.
            if (parsed.stream === 'text') {
              if (parsed.data.length > 0) {
                const chunk = parsed.data;
                // Each `text` frame is one complete assistant turn / agent_message.
                // Separate consecutive responses with a blank line so they don't
                // visually run together — and so Markdown renders them as distinct
                // blocks rather than one continuous paragraph.
                setCleanText((prev) => {
                  if (!prev) return chunk;
                  const sep = prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
                  return prev + sep + chunk;
                });
              }
            } else {
              term.write(parsed.data);
              if (parsed.data.length > 0) setHasOutput(true);
            }
          }
          break;
        case 'exit':
          setState('closed');
          setHasOutput(true);
          if (typeof parsed.code === 'number') {
            term.writeln(`\r\n\x1b[36m[CLI exited with code ${parsed.code}]\x1b[0m`);
            onExitRef.current?.(parsed.code);
          }
          break;
        case 'error':
          setState('error');
          setErrorMsg(typeof parsed.message === 'string' ? parsed.message : 'stream error');
          break;
      }
    };

    ws.onerror = () => {
      if (disposed) return;
      setState('error');
      setErrorMsg('websocket error');
    };

    ws.onclose = (ev) => {
      if (disposed) return;
      setState((prev) => (prev === 'error' ? prev : 'closed'));
      if (ev.code !== 1000) {
        term.writeln(
          `\r\n\x1b[31m[stream closed: ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}]\x1b[0m`,
        );
      }
    };

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      disposed = true;
      cancelAnimationFrame(fitRaf1);
      cancelAnimationFrame(fitRaf2);
      clearInterval(keepalive);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      detachWheel();
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // The component is re-mounted whenever invocationId changes, so the cleanup
    // tears down the old socket and a fresh one opens for the new invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invocationId, isReplay, staticOutput, staticExitCode]);

  // Re-fit xterm whenever the Raw panel becomes visible. While the Clean tab is
  // active the xterm container is display:none (zero size), so fit() must run
  // again on show or the grid stays collapsed.
  useEffect(() => {
    if (cleanSupported && tab !== 'raw') return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const t = termRef.current;
        if (t) t.refresh(0, t.rows - 1);
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(id);
  }, [tab, cleanSupported]);

  // CR-only sequences confuse HTML pre-wrap; JSON.parse already turned \n/\t into
  // real characters, so stripping bare \r is all the escaping the prose needs.
  const cleanContent = (isReplay ? (staticCleanOutput ?? '') : cleanText).replace(/\r/g, '');

  // Keep the Clean panel pinned to the latest output as it streams.
  useEffect(() => {
    const el = cleanScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cleanContent, tab]);

  // Nudge toward the Raw tab when a live run is clearly active (raw bytes flowing)
  // but the Clean tab is still empty after RAW_HINT_IDLE_MS — the model is working
  // yet has produced no parsed prose at all. Once any prose lands the hint is
  // suppressed for the rest of the run; a mid-run gap between frames is normal and
  // must not re-trigger it. Replay / no raw output / stream end also suppress it.
  useEffect(() => {
    const cleanIsEmpty = cleanText.trim().length === 0;
    if (isReplay || !cleanSupported || state !== 'connected' || !hasOutput || !cleanIsEmpty) {
      setShowRawHint(false);
      return;
    }
    const id = setTimeout(() => setShowRawHint(true), RAW_HINT_IDLE_MS);
    return () => clearTimeout(id);
  }, [isReplay, cleanSupported, state, hasOutput, cleanText]);

  const heightClass = height ?? (fill ? '' : 'h-[400px]');
  const showTabs = cleanSupported;
  const rawHidden = showTabs && tab !== 'raw';

  return (
    <div className={`flex flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          {isReplay ? (
            <span className="rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
              replay
            </span>
          ) : (
            <StatusBadge state={state} />
          )}
          {errorMsg && <span className="text-red-400">{errorMsg}</span>}
          {cancelError && <span className="text-red-400">cancel: {cancelError}</span>}
        </div>
        {!isReplay && (
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <span>Read-only — use Cancel to stop the running CLI</span>
            <button
              type="button"
              onClick={() => void cancelActiveCli()}
              disabled={cancelling || state !== 'connected'}
              className="rounded border border-red-700 px-2 py-0.5 text-red-300 hover:bg-red-950 disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel CLI'}
            </button>
          </div>
        )}
      </div>

      {showTabs && (
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'clean'} onClick={() => setTab('clean')}>
            Clean
          </TabButton>
          <TabButton
            active={tab === 'raw'}
            onClick={() => setTab('raw')}
            highlight={showRawHint && tab !== 'raw'}
          >
            Raw
          </TabButton>
          {showRawHint && tab !== 'raw' && (
            <span className="ml-1 text-[11px] text-amber-300/90">
              ← The model may be streaming to the Raw tab
            </span>
          )}
        </div>
      )}

      <div className={`w-full ${fill ? 'min-h-0 flex-1' : heightClass}`}>
        {/* Raw / xterm panel — always mounted so live frames are never lost;
            hidden (not unmounted) while the Clean tab is active. */}
        <div className={`relative h-full w-full ${rawHidden ? 'hidden' : ''}`}>
          <div
            ref={mountRef}
            className="h-full w-full rounded border border-neutral-800 bg-[#0a0a0a] p-2"
          />
          {!hasOutput && state !== 'error' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
              <span className="rounded bg-neutral-900/80 px-3 py-1">
                {state === 'connecting' ? 'Connecting…' : 'Waiting for CLI output…'}
              </span>
            </div>
          )}
        </div>
        {showTabs && tab === 'clean' && (
          <div
            ref={cleanScrollRef}
            className="h-full w-full overflow-auto rounded border border-neutral-800 bg-[#0a0a0a]"
          >
            {cleanContent.length === 0 ? (
              <div className="p-3 text-xs text-neutral-500">
                {isReplay
                  ? 'No model text for this run.'
                  : state === 'connecting'
                    ? 'Connecting…'
                    : 'No text generated by the model yet.'}
              </div>
            ) : looksLikeMarkdown(cleanContent) ? (
              // Model prose is Markdown — render it. react-markdown (v10, no
              // rehype-raw) escapes embedded HTML and strips javascript: URLs, so
              // this is safe for untrusted CLI output. enhanced=false skips the
              // spec-only quiz/before-after segmentation. The outer div owns the
              // scroll, so neutralize MarkdownView's own max-height/overflow.
              <MarkdownView
                body={cleanContent}
                enhanced={false}
                className="max-h-none overflow-visible p-3"
              />
            ) : (
              <div className="whitespace-pre-wrap break-words p-3 font-mono text-[13px] leading-relaxed text-neutral-200">
                {cleanContent}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  highlight = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] uppercase tracking-wider ${
        active
          ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
          : highlight
            ? 'animate-pulse border-amber-500/60 bg-amber-500/15 text-amber-200'
            : 'border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ state }: { state: ConnectionState }) {
  const color =
    state === 'connected'
      ? 'bg-green-500/20 text-green-300 border-green-500/40'
      : state === 'connecting'
        ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
        : state === 'error'
          ? 'bg-red-500/20 text-red-300 border-red-500/40'
          : 'bg-neutral-500/20 text-neutral-300 border-neutral-500/40';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${color}`}>
      {state}
    </span>
  );
}
