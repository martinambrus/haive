'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { apiWebSocketUrl } from '@/lib/api-client';
import { attachWheelScroll } from '@/lib/terminal-wheel';
import { copyTerminalSelection } from '@/lib/terminal-copy';
import { useTerminalCopy } from '@/lib/use-terminal-copy';
import { usePendingCliCopy } from '@/lib/use-pending-cli-copy';
import { stripDel } from '@/lib/terminal-sanitize';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button } from '@/components/ui';

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';

interface InteractiveShellProps {
  /** Session scope. Defaults to 'task'. Repo scope opens a standalone shell
   *  against a repository's checkout (no task), keyed on repositoryId. */
  scope?: 'task' | 'repo';
  /** Required for task scope. */
  taskId?: string;
  /** Required for repo scope. */
  repositoryId?: string;
  cliProviderId: string;
  fill?: boolean;
}

const KEEPALIVE_INTERVAL_MS = 30_000;
const WORKDIR_PROBE_INTERVAL_MS = 15_000;

interface WorkdirMismatch {
  sessionPath: string;
  expected: string;
}

function parseWorkdirMismatch(value: unknown): WorkdirMismatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sessionPath, expected } = value as Record<string, unknown>;
  return typeof sessionPath === 'string' && typeof expected === 'string'
    ? { sessionPath, expected }
    : null;
}

export function InteractiveShell(props: InteractiveShellProps) {
  const { cliProviderId, fill = false } = props;
  const scope = props.scope ?? 'task';
  const scopeId = scope === 'repo' ? props.repositoryId : props.taskId;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [containerLabel, setContainerLabel] = useState<string | null>(null);
  const [workdirMismatch, setWorkdirMismatch] = useState<WorkdirMismatch | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const sendFrameRef = useRef<((frame: unknown) => void) | null>(null);
  const restartingRef = useRef(false);
  const { attach: attachCopy, copy, hasSelection, copied } = useTerminalCopy();
  const {
    provider: cliClipboard,
    pendingChars: cliPendingChars,
    copied: cliCopied,
    copyPending,
  } = usePendingCliCopy();

  useEffect(() => {
    if (!scopeId) return;
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
      // Silences xterm's own "Parsing error" console.error on arbitrary shell bytes —
      // see CliStreamViewer for why no sanitizer can cover it. App errors are unaffected.
      logLevel: 'off',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon(undefined, cliClipboard));
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          copyTerminalSelection(sel);
          return false;
        }
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });
    term.open(mountRef.current);
    const detachWheel = attachWheelScroll(term);
    const detachCopy = attachCopy(term);
    let disposed = false;
    let fitRaf1 = 0;
    let fitRaf2 = 0;
    fitRaf1 = requestAnimationFrame(() => {
      fitRaf2 = requestAnimationFrame(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
          term.focus();
        } catch {
          // ignore
        }
      });
    });

    const wsPath =
      scope === 'repo'
        ? `/terminal-repo-shell/${scopeId}/${cliProviderId}`
        : `/terminal-shell/${scopeId}/${cliProviderId}`;
    const wsUrl = apiWebSocketUrl(wsPath);
    const ws = new WebSocket(wsUrl);
    setState('connecting');
    setWorkdirMismatch(null);

    const sendFrame = (frame: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    };
    sendFrameRef.current = sendFrame;

    const reconnectIfRestarting = () => {
      if (!restartingRef.current) return;
      restartingRef.current = false;
      setConnectNonce((n) => n + 1);
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
      if (disposed) return;
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
          if (typeof parsed.containerName === 'string') setContainerLabel(parsed.containerName);
          setWorkdirMismatch(parseWorkdirMismatch(parsed.workdirMismatch));
          handleResize();
          term.focus();
          setTimeout(() => handleResize(), 250);
          setTimeout(() => handleResize(), 1000);
          break;
        case 'output':
          if (typeof parsed.data === 'string') term.write(stripDel(parsed.data));
          break;
        case 'exit':
          setState('closed');
          term.writeln('\r\n\x1b[36m[shell exited]\x1b[0m');
          if (parsed.reason === 'restart') restartingRef.current = true;
          reconnectIfRestarting();
          break;
        case 'error':
          setState('error');
          setErrorMsg(typeof parsed.message === 'string' ? parsed.message : 'stream error');
          term.writeln(
            `\r\n\x1b[31m[error: ${typeof parsed.message === 'string' ? parsed.message : 'unknown'}]\x1b[0m`,
          );
          break;
        case 'workdir':
          setWorkdirMismatch(parseWorkdirMismatch(parsed.workdirMismatch));
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
      reconnectIfRestarting();
      if (ev.code !== 1000) {
        term.writeln(
          `\r\n\x1b[31m[socket closed: ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}]\x1b[0m`,
        );
      }
    };

    const keepalive = setInterval(() => {
      sendFrame({ type: 'ping' });
    }, KEEPALIVE_INTERVAL_MS);
    // A Retry elsewhere can move the task's workspace while this shell stays open.
    const workdirProbe =
      scope === 'task'
        ? setInterval(() => {
            if (document.visibilityState === 'visible') sendFrame({ type: 'probe_workdir' });
          }, WORKDIR_PROBE_INTERVAL_MS)
        : null;

    return () => {
      disposed = true;
      sendFrameRef.current = null;
      cancelAnimationFrame(fitRaf1);
      cancelAnimationFrame(fitRaf2);
      clearInterval(keepalive);
      if (workdirProbe) clearInterval(workdirProbe);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      detachWheel();
      detachCopy();
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      term.dispose();
    };
  }, [scope, scopeId, cliProviderId, attachCopy, cliClipboard, connectNonce]);

  function restartShell() {
    restartingRef.current = true;
    setConfirmRestart(false);
    sendFrameRef.current?.({ type: 'restart_shell' });
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
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-neutral-500">
            Shift+drag to select (the shell&apos;s own mouse mode takes a plain drag), then Copy or
            right-click.
          </span>
          {cliPendingChars !== null && (
            <button
              type="button"
              onClick={copyPending}
              title="The CLI asked to copy this, but the browser only allows a clipboard write from a click. Click to complete it."
              className="rounded border border-indigo-600 px-2 py-0.5 text-xs text-indigo-300 hover:bg-indigo-950"
            >
              {cliCopied ? 'Copied' : `Copy from CLI (${cliPendingChars})`}
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            disabled={!hasSelection}
            title="Copy the selected text. Hold Shift while dragging to select."
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="text-[10px] text-neutral-500">
            Container kept alive 2 min after last disconnect.
          </span>
        </div>
      </div>
      {workdirMismatch && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded border border-amber-600/50 bg-amber-950/30 p-3 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="min-w-0 [overflow-wrap:anywhere]">
            This shell started in{' '}
            <code className="text-amber-200">{workdirMismatch.sessionPath}</code>; the task&apos;s
            workspace is now <code className="text-amber-200">{workdirMismatch.expected}</code>.
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0 self-start sm:self-auto"
            onClick={() => setConfirmRestart(true)}
          >
            Restart shell here
          </Button>
        </div>
      )}
      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart this shell?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-neutral-300">
            The running shell will be closed, along with anything running in it. A new shell then
            opens in the task&apos;s current workspace.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmRestart(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={restartShell}>
              Restart shell
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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

export function ShellUnavailable(props: {
  reason: 'ended' | 'preparing';
  repositoryId?: string;
  repositoryName?: string | null;
}) {
  if (props.reason === 'preparing') {
    return (
      <div className="flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
        <p>
          Terminal is preparing. It opens once the task&apos;s git worktree has been created (step
          01-worktree-setup) so the shell starts on the task branch. It connects automatically when
          the worktree is ready.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-950 p-6 text-sm text-neutral-400">
      <p>
        Terminal is disabled because the task has ended (completed or cancelled). The per-task
        sandbox container has been torn down.
      </p>
      <p>
        To run a shell against this repository&apos;s checkout, open a standalone terminal from the
        repositories section:
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {props.repositoryId && (
          <Link
            href={`/repos/${props.repositoryId}/terminal`}
            className="text-indigo-400 underline"
          >
            Open terminal
            {props.repositoryName ? ` for ${props.repositoryName}` : ' for this repository'}
          </Link>
        )}
        <Link href="/repos" className="text-indigo-400 underline">
          Browse repositories
        </Link>
      </div>
    </div>
  );
}
