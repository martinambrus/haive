'use client';

import { useCallback, useRef, useState } from 'react';
import { api, API_BASE_URL } from '@/lib/api-client';
import { Button } from '@/components/ui';
import type { FormValues } from '@/components/form-renderer';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface PgTestResult {
  ok: boolean;
  error?: string;
}

interface OllamaTestResult {
  ok: boolean;
  reachable: boolean;
  error?: string;
  modelCount?: number;
  modelFound?: boolean | null;
  models?: string[];
}

interface PullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/* ------------------------------------------------------------------ */
/* PostgreSQL test (renders below ragConnectionString field)            */
/* ------------------------------------------------------------------ */

export function PostgresTestButton({ formValues }: { formValues: FormValues }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PgTestResult | null>(null);

  const ragMode = formValues.ragMode as string;
  const connStr = formValues.ragConnectionString as string | undefined;

  async function test() {
    if (ragMode === 'internal') {
      setResult({ ok: true });
      return;
    }
    if (ragMode === 'none') return;
    const effective = connStr || null;
    if (!effective) {
      setResult({ ok: false, error: 'No connection string provided' });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const res = await api.post<PgTestResult>('/tooling/test-postgres', {
        connectionString: effective,
      });
      setResult(res);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  if (ragMode === 'none') return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div>
        <Button type="button" variant="secondary" size="sm" disabled={testing} onClick={test}>
          {testing ? 'Testing...' : 'Test connection'}
        </Button>
      </div>
      {result && (
        <div
          className={`rounded px-2 py-1 text-xs ${result.ok ? 'bg-green-950/60 text-green-300' : 'bg-red-950/60 text-red-300'}`}
        >
          {result.ok
            ? ragMode === 'internal'
              ? 'Internal mode — will create a per-project database on haive PostgreSQL.'
              : 'Connection successful.'
            : `Connection failed: ${result.error}`}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ollama test + model pull (renders below embeddingModel field)        */
/* ------------------------------------------------------------------ */

export function OllamaTestButton({ formValues }: { formValues: FormValues }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<OllamaTestResult | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullDone, setPullDone] = useState(false);
  const pullIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ollamaUrl = formValues.ollamaUrl as string;
  const model = formValues.embeddingModel as string | undefined;

  const testConnection = useCallback(async () => {
    setTesting(true);
    setResult(null);
    setPullDone(false);
    setPullError(null);
    try {
      const res = await api.post<OllamaTestResult>('/tooling/test-ollama', {
        ollamaUrl,
        model: model || undefined,
      });
      setResult(res);
    } catch (err) {
      setResult({ ok: false, reachable: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [ollamaUrl, model]);

  async function pullModel() {
    if (!model) return;
    setPulling(true);
    setPullProgress(null);
    setPullError(null);
    setPullDone(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`${API_BASE_URL}/tooling/pull-ollama-model`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaUrl, model }),
        signal: controller.signal,
      });

      const reader = resp.body?.getReader();
      if (!reader) {
        setPullError('No response body');
        setPulling(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          try {
            const obj = JSON.parse(dataStr) as PullProgress & {
              pullId?: string;
              error?: string;
            };
            if (obj.pullId) pullIdRef.current = obj.pullId;
            if (obj.error) {
              setPullError(obj.error);
              setPulling(false);
              return;
            }
            setPullProgress({
              status: obj.status,
              digest: obj.digest,
              total: obj.total,
              completed: obj.completed,
            });
          } catch {
            // skip
          }
        }
      }

      setPullDone(true);
      void testConnection();
    } catch (err) {
      if (controller.signal.aborted) {
        setPullError('Pull cancelled.');
      } else {
        setPullError((err as Error).message);
      }
    } finally {
      setPulling(false);
      abortRef.current = null;
      pullIdRef.current = null;
    }
  }

  function cancelPull() {
    abortRef.current?.abort();
    if (pullIdRef.current) {
      void api.post('/tooling/cancel-pull', { pullId: pullIdRef.current }).catch(() => {});
    }
  }

  const pct =
    pullProgress?.total && pullProgress.completed
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testing || pulling}
          onClick={testConnection}
        >
          {testing ? 'Testing...' : 'Test Ollama + model'}
        </Button>
      </div>

      {result && !pulling && !pullDone && (
        <div
          className={`rounded px-2 py-1 text-xs ${result.ok ? 'bg-green-950/60 text-green-300' : 'bg-red-950/60 text-red-300'}`}
        >
          {result.ok ? (
            <span>
              Ollama reachable ({result.modelCount} model{result.modelCount !== 1 ? 's' : ''}).
              {result.modelFound === true && model && (
                <span className="ml-1 font-medium">Model &quot;{model}&quot; found.</span>
              )}
              {result.modelFound === false && model && (
                <span className="ml-1 font-medium text-amber-300">
                  Model &quot;{model}&quot; not found.
                </span>
              )}
            </span>
          ) : (
            `Ollama unreachable: ${result.error}`
          )}
        </div>
      )}

      {result?.ok && result.modelFound === false && model && !pulling && !pullDone && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={pullModel}>
            Pull &quot;{model}&quot;
          </Button>
          <span className="text-xs text-neutral-500">Download the model to Ollama</span>
        </div>
      )}

      {pulling && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-neutral-300">
            <span>
              {pullProgress?.status ?? 'Starting pull...'}
              {pullProgress?.digest ? ` (${pullProgress.digest.slice(0, 12)})` : ''}
            </span>
            <Button type="button" variant="destructive" size="sm" onClick={cancelPull}>
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
              {pct}% ({formatBytes(pullProgress?.completed ?? 0)} /{' '}
              {formatBytes(pullProgress?.total ?? 0)})
            </span>
          )}
        </div>
      )}

      {pullDone && (
        <div className="rounded bg-green-950/60 px-2 py-1 text-xs text-green-300">
          Model &quot;{model}&quot; pulled successfully.
        </div>
      )}

      {pullError && !pulling && (
        <div className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">{pullError}</div>
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
