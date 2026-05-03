'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { apiWebSocketUrl } from '@/lib/api-client';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';

interface InteractiveShellProps {
  taskId: string;
  cliProviderId: string;
  /** When true, the parent task moved to a terminal state and the shell
   *  should refuse to mount / show a disabled banner. */
  disabled?: boolean;
  fill?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

export function InteractiveShell({
  taskId,
  cliProviderId,
  disabled = false,
  fill = false,
}: InteractiveShellProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [containerLabel, setContainerLabel] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) return;
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
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());
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
    const wsUrl = apiWebSocketUrl(`/terminal-shell/${taskId}/${cliProviderId}`);
    const ws = new WebSocket(wsUrl);
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
      // Shell terminal forwards everything — Ctrl+C to kill processes is
      // table-stakes here, unlike the read-only step terminal.
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
          if (typeof parsed.containerName === 'string') setContainerLabel(parsed.containerName);
          handleResize();
          term.focus();
          setTimeout(() => handleResize(), 250);
          setTimeout(() => handleResize(), 1000);
          break;
        case 'output':
          if (typeof parsed.data === 'string') term.write(parsed.data);
          break;
        case 'exit':
          setState('closed');
          term.writeln('\r\n\x1b[36m[shell exited]\x1b[0m');
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
  }, [taskId, cliProviderId, disabled]);

  if (disabled) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
        Terminal is disabled because the task has ended (completed, failed, or cancelled). The
        underlying container has been torn down.
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}>
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <StatusBadge state={state} />
          {containerLabel && (
            <span className="font-mono text-[10px] text-neutral-500">{containerLabel}</span>
          )}
          {errorMsg && <span className="text-red-400">{errorMsg}</span>}
        </div>
        <div className="text-[10px] text-neutral-500">
          Container kept alive 2 min after last disconnect.
        </div>
      </div>
      <div
        ref={mountRef}
        className={`w-full rounded border border-neutral-800 bg-[#0a0a0a] p-2 ${fill ? 'min-h-0 flex-1' : 'h-[600px]'}`}
      />
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
