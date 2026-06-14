'use client';

import { useRef, useState } from 'react';
import { api, API_BASE_URL } from '@/lib/api-client';
import { Button } from '@/components/ui';

interface PullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** Download (pull) an Ollama model into the in-stack daemon with live progress
 *  and cancel, for users who don't run `ollama` themselves. Mirrors the
 *  connection-tester (online-link step) pull flow and reuses the same
 *  /tooling/pull-ollama-model (SSE) + /tooling/cancel-pull endpoints. The pull
 *  is idempotent: an already-resident model completes instantly. */
export function OllamaModelDownload({ model, ollamaUrl }: { model: string; ollamaUrl: string }) {
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pullIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function download() {
    const m = model.trim();
    if (!m) return;
    setPulling(true);
    setProgress(null);
    setError(null);
    setDone(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const resp = await fetch(`${API_BASE_URL}/tooling/pull-ollama-model`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaUrl, model: m }),
        signal: controller.signal,
      });
      const reader = resp.body?.getReader();
      if (!reader) {
        setError('No response body');
        setPulling(false);
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          try {
            const obj = JSON.parse(dataStr) as PullProgress & { pullId?: string; error?: string };
            if (obj.pullId) pullIdRef.current = obj.pullId;
            if (obj.error) {
              setError(obj.error);
              setPulling(false);
              return;
            }
            setProgress({
              status: obj.status,
              digest: obj.digest,
              total: obj.total,
              completed: obj.completed,
            });
          } catch {
            // skip malformed/partial line
          }
        }
      }
      setDone(true);
    } catch (err) {
      setError(controller.signal.aborted ? 'Download cancelled.' : (err as Error).message);
    } finally {
      setPulling(false);
      abortRef.current = null;
      pullIdRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    if (pullIdRef.current) {
      void api.post('/tooling/cancel-pull', { pullId: pullIdRef.current }).catch(() => {});
    }
  }

  const pct =
    progress?.total && progress.completed
      ? Math.round((progress.completed / progress.total) * 100)
      : null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {!pulling && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!model.trim()}
            onClick={download}
          >
            Download model
          </Button>
          <span className="text-xs text-neutral-500">Pull into the in-stack Ollama daemon.</span>
        </div>
      )}

      {pulling && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-neutral-300">
            <span>
              {progress?.status ?? 'Starting download...'}
              {progress?.digest ? ` (${progress.digest.slice(0, 12)})` : ''}
            </span>
            <Button type="button" variant="destructive" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {pct !== null && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {pct !== null && (
            <span className="text-xs text-neutral-500">
              {pct}% ({formatBytes(progress?.completed ?? 0)} / {formatBytes(progress?.total ?? 0)})
            </span>
          )}
        </div>
      )}

      {done && (
        <div className="rounded bg-green-950/60 px-2 py-1 text-xs text-green-300">
          Model &quot;{model.trim()}&quot; is ready.
        </div>
      )}

      {error && !pulling && (
        <div className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">{error}</div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
