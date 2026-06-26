'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE_URL } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

// The "test in your own browser" info box — the direct-mode counterpart to
// BrowserVncPanel. Instead of streaming the in-container browser over VNC, it shows
// the URL(s) the user opens in THEIR browser (localhost + *.ddev.site), fetched from
// /tasks/:id/access-urls. That endpoint runs the same runtime-ensure handshake the
// VNC bridge uses, so it returns once the app is serving and its port is published.

interface AccessEndpoint {
  kind: 'localhost' | 'ddev-http' | 'ddev-https' | 'proxy-subdomain';
  label: string;
  url: string;
  trusted?: boolean;
}
interface AccessUrlsResponse {
  enabled: boolean;
  accessUrls: AccessEndpoint[];
  pending?: boolean;
}
type State = 'idle' | 'loading' | 'ready' | 'pending' | 'disabled' | 'error';

interface BrowserDirectPanelProps {
  taskId: string;
  /** Header label; defaults to the direct-testing wording. */
  title?: string;
  /** When this flips true (the owning step finished), collapse so a finished step
   *  doesn't keep the box open behind later steps. The user can re-open it. */
  autoCollapse?: boolean;
  /** Stable id (e.g. the owning step id) to persist collapsed/expanded per task. */
  persistId?: string;
}

// While the runtime cold-boots the access-urls endpoint returns an empty list (202);
// retry quietly a bounded number of times before surfacing an error, like the VNC panel.
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 3000;

export function BrowserDirectPanel({
  taskId,
  title,
  autoCollapse,
  persistId,
}: BrowserDirectPanelProps) {
  const [expanded, setExpanded] = usePersistedToggle(
    persistId ? `task-ui:${taskId}:direct:${persistId}` : null,
    true,
  );
  const [state, setState] = useState<State>('idle');
  const [urls, setUrls] = useState<AccessEndpoint[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setMessage(null);
    try {
      const data = await api.get<AccessUrlsResponse>(`/tasks/${taskId}/access-urls`);
      if (!data.enabled) {
        setState('disabled');
        return;
      }
      if (data.accessUrls.length > 0) {
        setUrls(data.accessUrls);
        retriesRef.current = 0;
        setState('ready');
        return;
      }
      // Empty list → the runtime is still coming up; retry quietly until it's ready.
      if (retriesRef.current < MAX_RETRIES) {
        retriesRef.current += 1;
        setState('pending');
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => void load(), RETRY_DELAY_MS);
      } else {
        setMessage('The app environment is taking longer than expected to start.');
        setState('error');
      }
    } catch (err) {
      setMessage((err as Error).message ?? 'Failed to load the access URLs');
      setState('error');
    }
  }, [taskId]);

  useEffect(() => {
    if (expanded && state === 'idle') void load();
  }, [expanded, state, load]);

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  // Collapse once the owning step finishes (false→true edge only, not on mount, so a
  // reload of an already-finished step doesn't clobber a persisted "expanded").
  const prevAutoCollapse = useRef(autoCollapse);
  useEffect(() => {
    if (autoCollapse && !prevAutoCollapse.current) setExpanded(false);
    prevAutoCollapse.current = autoCollapse;
  }, [autoCollapse, setExpanded]);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    void load();
  }, [load]);

  const copy = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(url);
        setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
      },
      () => {},
    );
  }, []);

  const caHref = `${API_BASE_URL}/tasks/${taskId}/ddev-ca`;
  const hasTrustedHttps = urls.some((u) => u.kind === 'ddev-https' && u.trusted);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          {title ?? 'Open the app in your browser'}
          {state === 'ready' && <span className="ml-2 text-emerald-400">● ready</span>}
          {(state === 'loading' || state === 'pending') && (
            <span className="ml-2 text-neutral-500">starting…</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-indigo-400 underline"
        >
          {expanded ? 'Hide' : 'Show'} URLs
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 px-1 py-1">
          {state === 'ready' ? (
            <>
              <p className="text-xs text-neutral-400">
                Test the running app in your own browser at any of these URLs:
              </p>
              <ul className="flex flex-col gap-1">
                {urls.map((u) => (
                  <li key={u.kind} className="flex items-center gap-2 text-sm">
                    <span className="w-28 shrink-0 text-xs text-neutral-500">{u.label}</span>
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-indigo-300 underline"
                    >
                      {u.url}
                    </a>
                    <button
                      type="button"
                      onClick={() => copy(u.url)}
                      className="shrink-0 text-xs text-neutral-400 underline hover:text-neutral-200"
                    >
                      {copied === u.url ? 'copied' : 'copy'}
                    </button>
                  </li>
                ))}
              </ul>
              {hasTrustedHttps && (
                <p className="text-xs text-neutral-500">
                  For the HTTPS URL to be trusted (no certificate warning),{' '}
                  <a href={caHref} className="text-indigo-400 underline" download>
                    install the local CA
                  </a>{' '}
                  once.
                </p>
              )}
            </>
          ) : state === 'disabled' ? (
            <p className="text-sm text-amber-400">
              Direct browser access is turned off by an administrator.
            </p>
          ) : state === 'error' ? (
            <div className="flex flex-col items-start gap-1">
              <p className="text-sm text-amber-400">{message ?? 'Could not load the app URL.'}</p>
              <button type="button" onClick={retry} className="text-xs text-indigo-400 underline">
                Retry
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400" />
              <p className="text-sm text-neutral-300">
                Starting the app environment… first boot can take a minute or two.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
