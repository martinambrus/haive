'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

// The "connect to the database" info box — the DB counterpart to BrowserDirectPanel.
// Instead of a browser URL it shows the connection parameters + a ready URI for the task's
// DDEV database, exposed on a loopback host port. Fetched from /tasks/:id/db-access, which
// runs the same coalesced runtime-ensure handshake the VNC bridge / browser panel use, so
// it returns once the app is serving and the db port is forwarded. Credentials are DDEV's
// well-known defaults (db/db); the port binds 127.0.0.1 on the Haive host.

interface DbEndpoint {
  kind: 'localhost' | 'ddev-http' | 'ddev-https' | 'proxy-subdomain' | 'database';
  label: string;
  url: string;
  engine?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}
interface DbAccessResponse {
  enabled: boolean;
  accessUrls: DbEndpoint[];
  pending?: boolean;
}
type State = 'idle' | 'loading' | 'ready' | 'pending' | 'disabled' | 'error';

// While the runtime cold-boots the db-access endpoint returns an empty list (202); retry
// quietly a bounded number of times before surfacing an error, like the browser panel.
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 3000;

interface DatabaseAccessPanelProps {
  taskId: string;
  /** Header label; defaults to the connect-to-database wording. */
  title?: string;
  /** When this flips true (the owning step finished), collapse so a finished step
   *  doesn't keep the box open behind later steps. The user can re-open it. */
  autoCollapse?: boolean;
  /** Stable id (e.g. the owning step id) to persist collapsed/expanded per task. */
  persistId?: string;
}

export function DatabaseAccessPanel({
  taskId,
  title,
  autoCollapse,
  persistId,
}: DatabaseAccessPanelProps) {
  const [expanded, setExpanded, setExpandedAuto] = usePersistedToggle(
    persistId ? `task-ui:${taskId}:db:${persistId}` : null,
    true,
  );
  const [state, setState] = useState<State>('idle');
  const [db, setDb] = useState<DbEndpoint | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setMessage(null);
    try {
      const data = await api.get<DbAccessResponse>(`/tasks/${taskId}/db-access`);
      if (!data.enabled) {
        setState('disabled');
        return;
      }
      const endpoint = data.accessUrls.find((u) => u.kind === 'database') ?? null;
      if (endpoint) {
        setDb(endpoint);
        retriesRef.current = 0;
        setState('ready');
        return;
      }
      // Empty → the runtime/forward is still coming up; retry quietly until it's ready.
      if (retriesRef.current < MAX_RETRIES) {
        retriesRef.current += 1;
        setState('pending');
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => void load(), RETRY_DELAY_MS);
      } else {
        setMessage('The database is taking longer than expected to become reachable.');
        setState('error');
      }
    } catch (err) {
      setMessage((err as Error).message ?? 'Failed to load the database connection');
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

  // Collapse once the owning step finishes (false→true edge only, not on mount).
  // Ephemeral setter: this programmatic collapse stays in-memory and never writes
  // localStorage, so a remount restores the open-by-default fallback instead of a
  // stale collapsed flag. Only the user's toggle persists.
  const prevAutoCollapse = useRef(autoCollapse);
  useEffect(() => {
    if (autoCollapse && !prevAutoCollapse.current) setExpandedAuto(false);
    prevAutoCollapse.current = autoCollapse;
  }, [autoCollapse, setExpandedAuto]);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    void load();
  }, [load]);

  const copy = useCallback((key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      },
      () => {},
    );
  }, []);

  const fields: { key: string; label: string; value: string }[] = db
    ? [
        { key: 'host', label: 'Host', value: db.host ?? '127.0.0.1' },
        { key: 'port', label: 'Port', value: db.port != null ? String(db.port) : '' },
        { key: 'user', label: 'User', value: db.user ?? 'db' },
        { key: 'password', label: 'Password', value: db.password ?? 'db' },
        { key: 'database', label: 'Database', value: db.database ?? 'db' },
      ]
    : [];

  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          {title ?? 'Connect to the database'}
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
          {expanded ? 'Hide' : 'Show'} connection
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 px-1 py-1">
          {state === 'ready' && db ? (
            <>
              <p className="text-xs text-neutral-400">
                Connect a local DB client ({db.engine ?? 'database'}) to the running project
                database with these settings:
              </p>
              <ul className="flex flex-col gap-1">
                {fields.map((f) => (
                  <li key={f.key} className="flex items-center gap-2 text-sm">
                    <span className="w-20 shrink-0 text-xs text-neutral-500">{f.label}</span>
                    <span className="truncate font-mono text-neutral-200">{f.value}</span>
                    <button
                      type="button"
                      onClick={() => copy(f.key, f.value)}
                      className="shrink-0 text-xs text-neutral-400 underline hover:text-neutral-200"
                    >
                      {copied === f.key ? 'copied' : 'copy'}
                    </button>
                  </li>
                ))}
                <li className="flex items-center gap-2 text-sm">
                  <span className="w-20 shrink-0 text-xs text-neutral-500">URI</span>
                  <span className="truncate font-mono text-indigo-300">{db.url}</span>
                  <button
                    type="button"
                    onClick={() => copy('url', db.url)}
                    className="shrink-0 text-xs text-neutral-400 underline hover:text-neutral-200"
                  >
                    {copied === 'url' ? 'copied' : 'copy'}
                  </button>
                </li>
              </ul>
              <p className="text-xs text-neutral-500">
                DDEV default credentials. The port binds 127.0.0.1 on this machine.
              </p>
            </>
          ) : state === 'disabled' ? (
            <p className="text-sm text-amber-400">
              Direct database access is turned off by an administrator.
            </p>
          ) : state === 'error' ? (
            <div className="flex flex-col items-start gap-1">
              <p className="text-sm text-amber-400">
                {message ?? 'Could not load the database connection.'}
              </p>
              <button type="button" onClick={retry} className="text-xs text-indigo-400 underline">
                Retry
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400" />
              <p className="text-sm text-neutral-300">
                Starting the database… first boot can take a minute or two.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
