'use client';

import { useEffect, useRef, useState } from 'react';
import { api, API_BASE_URL, type ApiError, type TaskStatus } from '@/lib/api-client';
import { TaskSource } from '@/components/task-source';

interface EditorTabProps {
  taskId: string;
  taskStatus: TaskStatus;
}

interface EnsureIdeResponse {
  enabled: boolean;
  ready?: boolean;
  pending?: boolean;
  reason?: string;
}

// Tasks whose containers are torn down at end → no live editor; fall back to the
// read-only source viewer. 'failed' keeps its runtime for recovery, so it stays
// editable.
const ENDED_READONLY: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'cancelled']);

const RETRY_DELAY_MS = 2500;

type EditorState = 'starting' | 'ready' | 'unavailable' | 'error';

/** The Editor tab: a full browser VS Code (code-server) for the task's worktree,
 *  reverse-proxied through the api at /ide/<taskId>/. Lazily started on open via
 *  POST /tasks/:id/ensure-ide (polled while the worker boots / pulls the image),
 *  then embedded in an iframe. The proxied editor WebSocket holds the server alive
 *  while this tab is mounted; switching away unmounts the iframe, and the worker
 *  grace-stops the container 30 min later. Falls back to the read-only file viewer
 *  when the IDE is disabled, unavailable for the repo, or the task has ended. */
export function EditorTab({ taskId, taskStatus }: EditorTabProps) {
  const readOnly = ENDED_READONLY.has(taskStatus);
  const [state, setState] = useState<EditorState>('starting');
  const [message, setMessage] = useState<string>('');
  const [attemptKey, setAttemptKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    setState('starting');
    setMessage('');

    const clearTimer = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const attempt = async (): Promise<void> => {
      try {
        const res = await api.post<EnsureIdeResponse>(`/tasks/${taskId}/ensure-ide`);
        if (cancelled) return;
        if (res.enabled === false) {
          setState('unavailable');
          setMessage('The in-task editor is disabled by an administrator.');
          return;
        }
        if (res.ready) {
          setState('ready');
          return;
        }
        // 202 pending (the worker is still booting / pulling the image) — retry.
        timerRef.current = setTimeout(() => void attempt(), RETRY_DELAY_MS);
      } catch (err) {
        if (cancelled) return;
        const e = err as ApiError;
        if (e.status === 409) {
          setState('unavailable');
          setMessage(
            'No editable workspace for this task (read-only or local repository). Showing files read-only.',
          );
          return;
        }
        // Transient (network / 5xx) — keep retrying; the ensure job is coalesced.
        timerRef.current = setTimeout(() => void attempt(), RETRY_DELAY_MS);
      }
    };

    void attempt();
    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [taskId, readOnly, attemptKey]);

  if (readOnly) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-neutral-500">
          This task has ended — showing the workspace read-only.
        </p>
        <TaskSource taskId={taskId} />
      </div>
    );
  }

  if (state === 'ready') {
    return (
      <iframe
        src={`${API_BASE_URL}/ide/${taskId}/`}
        title="Editor"
        className="h-[75vh] w-full rounded border border-neutral-800 bg-neutral-950"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-neutral-400">{message}</p>
        <TaskSource taskId={taskId} />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex h-[75vh] flex-col items-center justify-center gap-3 rounded border border-neutral-800 bg-neutral-950">
        <p className="text-sm text-rose-300">{message || 'The editor failed to start.'}</p>
        <button
          type="button"
          onClick={() => setAttemptKey((k) => k + 1)}
          className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200 hover:bg-neutral-800"
        >
          Retry
        </button>
      </div>
    );
  }

  // starting
  return (
    <div className="flex h-[75vh] flex-col items-center justify-center gap-3 rounded border border-neutral-800 bg-neutral-950">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />
      <p className="text-sm text-neutral-400">Starting editor…</p>
      <p className="text-xs text-neutral-600">
        First launch can take a minute while the image downloads.
      </p>
    </div>
  );
}
