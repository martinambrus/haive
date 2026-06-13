'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type CliProvider, type Repository } from '@/lib/api-client';
import { Button, Card } from '@/components/ui';
import { InteractiveShell } from '@/components/terminal/InteractiveShell';
import { usePageTitle } from '@/lib/use-page-title';
import { isReadOnlyLocalRepo } from '@haive/shared/schemas';

export default function RepoTerminalPage() {
  const params = useParams<{ id: string }>();
  const repositoryId = params.id;
  const [repo, setRepo] = useState<Repository | null>(null);
  const [providers, setProviders] = useState<CliProvider[]>([]);
  const [selectedCliProviderId, setSelectedCliProviderId] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(repo ? `Terminal — ${repo.name}` : 'Terminal');

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ repository: Repository }>(`/repos/${repositoryId}`)
      .then((d) => {
        if (!cancelled) setRepo(d.repository);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load repository');
      });
    void api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((d) => {
        if (!cancelled) setProviders(d.providers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  const usableProviders = useMemo(() => {
    const enabled = providers.filter((p) => p.enabled);
    return enabled.length > 0 ? enabled : providers;
  }, [providers]);

  // Default the CLI to the first usable provider once the list arrives.
  useEffect(() => {
    if (selectedCliProviderId && usableProviders.some((p) => p.id === selectedCliProviderId))
      return;
    setSelectedCliProviderId(usableProviders[0]?.id ?? null);
  }, [usableProviders, selectedCliProviderId]);

  // Close the maximized overlay on Escape.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const isReadOnlyLocal = repo ? isReadOnlyLocalRepo(repo) : false;
  const notReady = repo != null && repo.status !== 'ready';

  const header = (
    <div className="flex items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        CLI environment
        <select
          value={selectedCliProviderId ?? ''}
          onChange={(e) => setSelectedCliProviderId(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
        >
          {usableProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.name})
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="hidden text-[10px] text-neutral-500 sm:inline">
          Shell runs in the repo&apos;s sandbox image. Container kept alive 2 min after disconnect.
        </span>
        <Button variant="secondary" size="sm" onClick={() => setMaximized((m) => !m)}>
          {maximized ? 'Minimize (Esc)' : 'Maximize'}
        </Button>
      </div>
    </div>
  );

  const shell =
    selectedCliProviderId != null ? (
      <InteractiveShell
        scope="repo"
        repositoryId={repositoryId}
        cliProviderId={selectedCliProviderId}
        fill
      />
    ) : (
      <Card className="p-4 text-sm text-neutral-400">
        No CLI providers configured. Add one in{' '}
        <Link href="/settings/cli-providers" className="text-indigo-400 underline">
          Settings → CLI providers
        </Link>{' '}
        to launch a shell.
      </Card>
    );

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (isReadOnlyLocal) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Card className="p-4 text-sm text-neutral-400">
          The interactive terminal is not available for read-only local-path repositories — their
          checkout is mounted read-only, so edits, commits, and pushes are not possible. Re-add the
          directory as a writable copy, or use an uploaded or cloned repository instead.
        </Card>
      </div>
    );
  }

  if (notReady) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Card className="p-4 text-sm text-neutral-400">
          Repository is {repo?.status}. The terminal becomes available once it is ready.
        </Card>
      </div>
    );
  }

  // Single keyed tree for both layouts. Maximize only swaps the root wrapper
  // classes (inline vs a full-window `fixed inset-0` overlay) and drops the
  // title block; the keyed `shell` subtree stays mounted across the toggle, so
  // the PTY/WebSocket never tears down. InteractiveShell's ResizeObserver
  // refits xterm to the new size automatically.
  return (
    <div
      className={
        maximized
          ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-neutral-950 p-4'
          : 'flex h-[calc(100vh-7rem)] flex-col gap-3'
      }
    >
      {!maximized && (
        <div key="title">
          <BackLink />
          <h1 className="mt-1 text-2xl font-semibold text-neutral-100">
            Terminal{repo ? ` — ${repo.name}` : ''}
          </h1>
        </div>
      )}
      <div key="header">{header}</div>
      <div key="shell" className="min-h-0 flex-1">
        {shell}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/repos" className="text-xs text-indigo-400 hover:underline">
      ← Back to repositories
    </Link>
  );
}
