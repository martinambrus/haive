'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api, type ApiError } from '@/lib/api-client';
import { editorNeedsSecureCookie } from '@/lib/editor-origin';
import { Button } from '@/components/ui';
import { TaskSource } from '@/components/task-source';
import { MarkdownView } from '@/components/markdown/markdown-view';

type EditorTabProps = (
  { taskId: string; repositoryId?: never } | { repositoryId: string; taskId?: never }
) & { className?: string };

interface EnsureIdeResponse {
  enabled: boolean;
  ready?: boolean;
  pending?: boolean;
  reason?: string;
}

const RETRY_DELAY_MS = 2500;

type EditorState = 'starting' | 'ready' | 'unavailable' | 'refused' | 'error';

/** The Editor tab: a full browser VS Code (code-server) for the task's worktree,
 *  opened through a single-use grant on the editor origin. Lazily started on open via
 *  POST /tasks/:id/ensure-ide (polled while the worker boots / pulls the image),
 *  then embedded in an iframe. The proxied editor WebSocket holds the server alive
 *  while this tab is mounted; switching away unmounts the iframe, and the worker
 *  grace-stops the container 30 min later. Falls back to the read-only file viewer
 *  when the IDE is disabled, unavailable for the repo, or the task has ended. */
export function EditorTab({ taskId, repositoryId, className }: EditorTabProps) {
  const ensurePath = repositoryId
    ? `/repos/${repositoryId}/ensure-ide`
    : `/tasks/${taskId}/ensure-ide`;
  const grantPath = repositoryId
    ? `/repos/${repositoryId}/editor-handshake`
    : `/tasks/${taskId}/editor-handshake`;
  const frameClassName = className ?? 'h-[75vh] w-full';
  const [state, setState] = useState<EditorState>('starting');
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const [attemptKey, setAttemptKey] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFullscreenChange = (): void => {
      setMaximized(editorRef.current != null && document.fullscreenElement === editorRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.fullscreenElement) setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const toggleMaximized = (): void => {
    if (maximized) {
      if (document.fullscreenElement === editorRef.current) {
        void document.exitFullscreen().catch(() => {});
      } else {
        setMaximized(false);
      }
      return;
    }
    setMaximized(true);
    // Keep a viewport-sized overlay when browser fullscreen is unavailable.
    void editorRef.current?.requestFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    setState('starting');
    setMessage('');
    setEditorUrl(null);

    const clearTimer = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const attempt = async (): Promise<void> => {
      try {
        const res = await api.post<EnsureIdeResponse>(ensurePath);
        if (cancelled) return;
        if (res.enabled === false) {
          setState('unavailable');
          setMessage('The editor is disabled by an administrator.');
          return;
        }
        if (res.ready) {
          try {
            const grant = await api.post<{ url: string }>(grantPath);
            if (cancelled) return;
            if (editorNeedsSecureCookie(window.location.origin, grant.url)) {
              setState('refused');
              setMessage(
                "Serve the editor over HTTPS or from a hostname under the app's domain, or set HAIVE_EDITOR_ORIGIN.",
              );
              return;
            }
            // Use the bootstrap URL verbatim. It redeems the grant and redirects to the
            // slash-terminated editor path covered by the scoped session cookie.
            setEditorUrl(grant.url);
            setState('ready');
          } catch (err) {
            if (cancelled) return;
            const e = err as ApiError;
            setState(e.status && e.status >= 400 && e.status < 500 ? 'refused' : 'error');
            setMessage(e.message || 'The editor could not be opened.');
          }
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
            repositoryId
              ? 'This repository has no editable workspace. The editor is available for ready, writable repositories.'
              : 'No editable workspace for this task (read-only or local repository). Showing files read-only.',
          );
          return;
        }
        if (e.status && e.status >= 400 && e.status < 500) {
          setState('refused');
          setMessage(e.message || 'The editor could not be opened.');
          return;
        }
        setState('error');
        setMessage(e.message || 'The editor could not be opened.');
      }
    };

    void attempt();
    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [ensurePath, grantPath, repositoryId, attemptKey]);

  if (state === 'ready' && editorUrl) {
    return (
      <div
        ref={editorRef}
        className={
          maximized
            ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-neutral-950 p-4'
            : `${frameClassName} flex min-h-0 flex-col gap-2`
        }
      >
        <div className="flex shrink-0 justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleMaximized}
            aria-pressed={maximized}
            title={maximized ? 'Restore editor size' : 'Open editor fullscreen'}
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            {maximized ? 'Minimize' : 'Maximize'}
          </Button>
        </div>
        {/* Keep the iframe mounted while changing size so the editor session and buffers survive. */}
        <iframe
          src={editorUrl}
          title="Editor"
          className="min-h-0 w-full flex-1 rounded border border-neutral-800 bg-neutral-950"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="space-y-3">
        <MarkdownView body={message} className="text-sm text-neutral-400" />
        {taskId && <TaskSource taskId={taskId} />}
      </div>
    );
  }

  if (state === 'error' || state === 'refused') {
    return (
      <div
        className={`${frameClassName} flex flex-col items-center justify-center gap-3 rounded border border-neutral-800 bg-neutral-950`}
      >
        <MarkdownView
          body={message || 'The editor failed to start.'}
          className="text-sm text-rose-300"
        />
        {state === 'error' && (
          <button
            type="button"
            onClick={() => setAttemptKey((k) => k + 1)}
            className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  // starting
  return (
    <div
      className={`${frameClassName} flex flex-col items-center justify-center gap-3 rounded border border-neutral-800 bg-neutral-950`}
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />
      <MarkdownView body="Starting editor…" className="text-sm text-neutral-400" />
      <MarkdownView
        body="First launch can take a minute while the image downloads."
        className="text-xs text-neutral-600"
      />
    </div>
  );
}
