'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWebSocketUrl } from '@/lib/api-client';

type VncState = 'idle' | 'connecting' | 'connected' | 'error';

interface BrowserVncPanelProps {
  taskId: string;
}

/**
 * Embedded noVNC view of the headed Chrome running on the DDEV runner's
 * virtual desktop (browser-testing interactive mode). The api bridges
 * RFB-over-WebSocket at /browser-vnc/<taskId> to the runner's VNC port over the
 * internal sandbox network. The user can watch the agent drive the browser and
 * click things agents can't reach (native Chrome popups). noVNC is imported
 * lazily in the browser only — it touches window at module load.
 */
export function BrowserVncPanel({ taskId }: BrowserVncPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [state, setState] = useState<VncState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<{ disconnect(): void } | null>(null);

  const disconnect = useCallback(() => {
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
      const { default: RFB } = await import('@novnc/novnc/core/rfb');
      const rfb = new RFB(containerRef.current, apiWebSocketUrl(`/browser-vnc/${taskId}`));
      rfb.scaleViewport = true;
      rfb.addEventListener('connect', () => setState('connected'));
      rfb.addEventListener('disconnect', () => {
        rfbRef.current = null;
        setState((prev) => {
          if (prev === 'connecting') {
            setMessage('Could not connect — is the browser desktop running for this task?');
            return 'error';
          }
          return 'idle';
        });
      });
      rfbRef.current = rfb;
    } catch (err) {
      setMessage((err as Error).message ?? 'Failed to load the VNC client');
      setState('error');
    }
  }, [taskId]);

  useEffect(() => {
    if (expanded && state === 'idle' && !rfbRef.current) void connect();
  }, [expanded, state, connect]);

  useEffect(() => () => disconnect(), [disconnect]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          Browser (interactive validation)
          {state === 'connected' && <span className="ml-2 text-emerald-400">● live</span>}
          {state === 'connecting' && <span className="ml-2 text-neutral-500">connecting…</span>}
        </span>
        <div className="flex gap-2">
          {state === 'error' && (
            <button
              type="button"
              onClick={() => void connect()}
              className="text-xs text-indigo-400 underline"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (expanded) disconnect();
              setExpanded((v) => !v);
            }}
            className="text-xs text-indigo-400 underline"
          >
            {expanded ? 'Hide' : 'Show'} browser
          </button>
        </div>
      </div>
      {expanded && message && <p className="text-xs text-amber-400">{message}</p>}
      {expanded && (
        <div
          ref={containerRef}
          className="h-[480px] w-full overflow-hidden rounded bg-black"
          // noVNC manages its own canvas inside this container.
        />
      )}
    </div>
  );
}
