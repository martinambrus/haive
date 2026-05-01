'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { api, apiWebSocketUrl } from '@/lib/api-client';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';

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
   *  button). Used to replay an ended invocation's persisted rawOutput from
   *  cli_invocations.raw_output without keeping a stream alive past the
   *  Redis-stream 600s expiry. */
  staticOutput?: string;
  /** Final exit code annotation for static replays (rendered in cyan after
   *  the buffered output). Ignored when staticOutput is unset. */
  staticExitCode?: number | null;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

export function CliStreamViewer({
  invocationId,
  taskId,
  onExit,
  fill = false,
  height,
  staticOutput,
  staticExitCode,
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

    // Read-only viewer: intercept Ctrl+C as a "kill the running CLI" shortcut.
    // Any other key is ignored (disableStdin already blocks input forwarding;
    // we use the key handler purely for the cancel hotkey).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && !ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          // Honor the standard "Ctrl+C copies selection" UX; only treat it
          // as cancel when nothing is selected.
          void navigator.clipboard.writeText(sel);
          return false;
        }
        term.writeln('\r\n\x1b[33m[Ctrl+C → cancelling running CLI…]\x1b[0m');
        void cancelActiveCli();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      return true;
    });

    term.open(mountRef.current);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      });
    });

    const handleResize = () => {
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
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        term.dispose();
      };
    }

    let disposed = false;
    const ws = new WebSocket(apiWebSocketUrl(`/cli-stream/${invocationId}`));
    setState('connecting');

    ws.onopen = () => {
      // server replays buffered chunks via XREAD from id 0 — nothing to send.
    };

    ws.onmessage = (ev) => {
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
            term.write(parsed.data);
            if (parsed.data.length > 0) setHasOutput(true);
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
      clearInterval(keepalive);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      term.dispose();
    };
    // The component is re-mounted whenever invocationId changes, so the cleanup
    // tears down the old socket and a fresh one opens for the new invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invocationId, isReplay, staticOutput, staticExitCode]);

  const heightClass = height ?? (fill ? '' : 'h-[400px]');
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
            <span>Read-only — Ctrl+C cancels the running CLI</span>
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
      <div className={`relative w-full ${fill ? 'min-h-0 flex-1' : heightClass}`}>
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
    </div>
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
