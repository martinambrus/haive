'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import {
  api,
  apiWebSocketUrl,
  type TerminalSessionDetail,
  type TerminalSessionSummary,
} from '@/lib/api-client';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';

interface TerminalProps {
  containerId: string;
  onExit?: (code: number) => void;
  fill?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

export function Terminal({ containerId, onExit, fill = false }: TerminalProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [forwardCtrlC, setForwardCtrlC] = useState(false);
  const forwardCtrlCRef = useRef(forwardCtrlC);
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const [rawLog, setRawLog] = useState<TerminalSessionDetail | null>(null);
  const [rawLogError, setRawLogError] = useState<string | null>(null);
  const [rawLogLoading, setRawLogLoading] = useState(false);

  const loadRawLog = async () => {
    setRawLogLoading(true);
    setRawLogError(null);
    try {
      const listing = await api.get<{ sessions: TerminalSessionSummary[] }>(
        `/terminal-sessions/by-container/${containerId}`,
      );
      const latest = listing.sessions[listing.sessions.length - 1];
      if (!latest) {
        setRawLog(null);
        setRawLogError('No terminal sessions recorded yet');
        return;
      }
      const detail = await api.get<{ session: TerminalSessionDetail }>(
        `/terminal-sessions/${latest.id}`,
      );
      setRawLog(detail.session);
    } catch (err) {
      setRawLogError((err as Error).message ?? 'Failed to load log');
    } finally {
      setRawLogLoading(false);
    }
  };

  const toggleRawLog = () => {
    const next = !rawLogOpen;
    setRawLogOpen(next);
    if (next && !rawLog && !rawLogLoading) {
      void loadRawLog();
    }
  };

  useEffect(() => {
    forwardCtrlCRef.current = forwardCtrlC;
  }, [forwardCtrlC]);

  useEffect(() => {
    if (!mountRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        black: '#0a0a0a',
        brightBlack: '#525252',
      },
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(clipboardAddon);
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });
    term.open(mountRef.current);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
          term.focus();
        } catch {
          // ignore
        }
      });
    });

    let disposed = false;
    let firstOutputSeen = false;
    const ws = new WebSocket(apiWebSocketUrl(`/terminal/${containerId}`));
    setState('connecting');

    const sendFrame = (frame: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    };

    const sendResize = () => {
      const { rows, cols } = term;
      if (rows > 0 && cols > 0) {
        sendFrame({ type: 'resize', rows, cols });
      }
    };

    const inputDisposable = term.onData((data) => {
      if (!forwardCtrlCRef.current) {
        if (data === '\u0003' || data === '\u0004') {
          term.writeln(
            `\r\n\x1b[33m[blocked ${data === '\u0003' ? 'Ctrl+C' : 'Ctrl+D'} — toggle "Forward Ctrl+C/D" to send]\x1b[0m`,
          );
          return;
        }
      }
      sendFrame({ type: 'input', data });
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
      sendResize();
    };
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(mountRef.current);

    ws.onopen = () => {
      sendResize();
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
          handleResize();
          term.focus();
          setTimeout(() => handleResize(), 250);
          setTimeout(() => handleResize(), 1000);
          break;
        case 'output':
          if (typeof parsed.data === 'string') {
            const wasEmpty = !firstOutputSeen;
            term.write(parsed.data);
            if (wasEmpty) {
              firstOutputSeen = true;
              requestAnimationFrame(() => handleResize());
            }
          }
          break;
        case 'exit':
          setState('closed');
          if (typeof parsed.code === 'number') {
            term.writeln(`\r\n\x1b[36m[session exited with code ${parsed.code}]\x1b[0m`);
            onExit?.(parsed.code);
          }
          break;
        case 'error':
          setState('error');
          setErrorMsg(typeof parsed.message === 'string' ? parsed.message : 'stream error');
          term.writeln(
            `\r\n\x1b[31m[error: ${typeof parsed.message === 'string' ? parsed.message : 'unknown'}]\x1b[0m`,
          );
          break;
        case 'pong':
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
          `\r\n\x1b[31m[socket closed: ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}]\x1b[0m`,
        );
      }
    };

    const keepalive = setInterval(() => {
      sendFrame({ type: 'ping' });
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(keepalive);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      term.dispose();
    };
  }, [containerId, onExit]);

  return (
    <div className={`flex flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge state={state} />
          {errorMsg && <span className="text-red-400">{errorMsg}</span>}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleRawLog}
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            {rawLogOpen ? 'Hide raw log' : 'View raw log'}
          </button>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={forwardCtrlC}
              onChange={(e) => setForwardCtrlC(e.target.checked)}
              className="h-3 w-3"
            />
            Forward Ctrl+C/D
          </label>
        </div>
      </div>
      <div
        ref={mountRef}
        className={`w-full rounded border border-neutral-800 bg-[#0a0a0a] p-2 ${fill ? 'min-h-0 flex-1' : 'h-[600px]'}`}
      />
      {rawLogOpen && (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-neutral-400">
            <span>
              Raw PTY log (server-side capture)
              {rawLog && (
                <>
                  {' — '}
                  <span className="text-neutral-500">
                    {rawLog.byteCount.toLocaleString()} bytes
                    {rawLog.truncated ? ' (truncated to most recent)' : ''}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => void loadRawLog()}
              className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
              disabled={rawLogLoading}
            >
              {rawLogLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          {rawLogError && <div className="text-xs text-red-400">{rawLogError}</div>}
          {rawLog && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-neutral-200">
              {rawLog.fullLog || '(empty)'}
            </pre>
          )}
        </div>
      )}
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
