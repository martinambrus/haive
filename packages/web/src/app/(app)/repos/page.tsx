'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, type Repository } from '@/lib/api-client';
import { Button, Badge, Card, CardHeader, CardTitle, CardDescription } from '@/components/ui';

function statusVariant(status: Repository['status']) {
  if (status === 'ready') return 'success' as const;
  if (status === 'error') return 'error' as const;
  return 'warning' as const;
}

function deriveTopLevelPaths(fileTree: string[] | null): string[] {
  if (!fileTree) return [];
  const set = new Set<string>();
  for (const file of fileTree) {
    const head = file.split('/')[0];
    if (head) set.add(head);
  }
  return Array.from(set).sort();
}

function normalizeExclusion(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null);
  const [pendingExclusions, setPendingExclusions] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  async function reload() {
    try {
      const data = await api.get<{ repositories: Repository[] }>('/repos');
      setRepos(data.repositories);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load repositories');
    }
  }

  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, []);

  async function handleDelete(id: string) {
    if (!confirm('Delete this repository?')) return;
    try {
      await api.delete(`/repos/${id}`);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to delete repository');
    }
  }

  function toggleExpand(repo: Repository) {
    if (expandedRepoId === repo.id) {
      setExpandedRepoId(null);
      return;
    }
    const initial = new Set<string>((repo.excludedPaths ?? []).map(normalizeExclusion));
    setPendingExclusions(initial);
    setExpandedRepoId(repo.id);
  }

  function togglePath(path: string) {
    setPendingExclusions((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function saveExclusions(repoId: string) {
    setSaving(true);
    try {
      await api.patch(`/repos/${repoId}/exclusions`, {
        excludedPaths: Array.from(pendingExclusions).sort(),
      });
      setExpandedRepoId(null);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update exclusions');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Repositories</h1>
          <p className="text-sm text-neutral-400">
            Local checkouts and remote clones. Status updates live every few seconds.
          </p>
        </div>
        <Link href="/repos/new">
          <Button>Add repository</Button>
        </Link>
      </div>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {repos === null && <div className="text-sm text-neutral-500">Loading...</div>}

      {repos && repos.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No repositories yet</CardTitle>
            <CardDescription>
              Add one to start running orchestration tasks against it.
            </CardDescription>
          </CardHeader>
          <Link href="/repos/new">
            <Button size="sm">Add repository</Button>
          </Link>
        </Card>
      )}

      {repos && repos.length > 0 && (
        <div className="grid gap-4">
          {repos.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              expanded={expandedRepoId === repo.id}
              pendingExclusions={pendingExclusions}
              saving={saving && expandedRepoId === repo.id}
              onExpand={() => toggleExpand(repo)}
              onDelete={() => handleDelete(repo.id)}
              onTogglePath={togglePath}
              onSave={() => saveExclusions(repo.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RepoCardProps {
  repo: Repository;
  expanded: boolean;
  pendingExclusions: Set<string>;
  saving: boolean;
  onExpand: () => void;
  onDelete: () => void;
  onTogglePath: (path: string) => void;
  onSave: () => void;
}

function RepoCard(props: RepoCardProps) {
  const { repo, expanded, pendingExclusions, saving, onExpand, onDelete, onTogglePath, onSave } =
    props;

  const topLevelPaths = useMemo(() => deriveTopLevelPaths(repo.fileTree), [repo.fileTree]);
  const canEdit = repo.status === 'ready' && topLevelPaths.length > 0;
  const excludedCount = repo.excludedPaths?.length ?? 0;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-neutral-50">{repo.name}</h2>
            <Badge variant={statusVariant(repo.status)}>{repo.status}</Badge>
            {repo.detectedFramework && <Badge>{repo.detectedFramework}</Badge>}
            {excludedCount > 0 && (
              <Badge variant="warning">
                {excludedCount} excluded path{excludedCount === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {repo.localPath ?? repo.remoteUrl ?? '(no path)'}
          </p>
          {repo.statusMessage && <p className="mt-1 text-xs text-red-400">{repo.statusMessage}</p>}
        </div>
        <div className="flex gap-2">
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={onExpand}>
              {expanded ? 'Close' : 'Exclusions'}
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      {repo.detectedLanguages && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(repo.detectedLanguages)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([lang, count]) => (
              <Badge key={lang}>
                {lang}: {count}
              </Badge>
            ))}
        </div>
      )}
      {expanded && canEdit && (
        <div className="mt-2 border-t border-neutral-800 pt-3">
          <p className="mb-2 text-sm font-semibold text-neutral-100">Top-level exclusions</p>
          <p className="mb-3 text-xs text-neutral-500">
            Uncheck directories to include them in ingestion, or check to exclude them. Applies to
            KB mining, RAG, and analysis steps.
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {topLevelPaths.map((p) => {
              const isExcluded = pendingExclusions.has(p);
              return (
                <label
                  key={p}
                  className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
                >
                  <input
                    type="checkbox"
                    checked={isExcluded}
                    onChange={() => onTogglePath(p)}
                    className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 accent-indigo-500"
                  />
                  <span className={isExcluded ? 'text-neutral-500 line-through' : ''}>{p}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
