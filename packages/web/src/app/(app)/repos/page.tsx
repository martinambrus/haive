'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TreeNode } from '@haive/shared';
import { api, API_BASE_URL, type Repository } from '@/lib/api-client';
import { Button, Badge, Card, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { DirectoryTreeSelect } from '@/components/directory-tree-select';
import { UpgradeAvailableBanner } from '@/components/upgrade-available-banner';
import { ToolingUpgradeBanner } from '@/components/tooling-upgrade-banner';
import { usePageTitle } from '@/lib/use-page-title';
import { isReadOnlyLocalRepo } from '@haive/shared/schemas';

function statusVariant(status: Repository['status']) {
  if (status === 'ready') return 'success' as const;
  if (status === 'error') return 'error' as const;
  return 'warning' as const;
}

/* ------------------------------------------------------------------ */
/* Scope-tree <-> deny-list conversion (mirrors onboarding step 06_7)  */
/* ------------------------------------------------------------------ */

function collectAllPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.path);
    if (n.children) out.push(...collectAllPaths(n.children));
  }
  return out;
}

/** A path is covered by the deny list when it IS a deny glob or sits under one. */
function isCoveredByDeny(p: string, deny: readonly string[]): boolean {
  for (const d of deny) {
    if (p === d || p.startsWith(`${d}/`)) return true;
  }
  return false;
}

/** The DirectoryTreeSelect value is the INCLUDED set (every node in scope listed
 *  explicitly). Derive it from the stored deny list = every tree path not denied. */
function includedFromDeny(tree: TreeNode[], deny: readonly string[]): string[] {
  return collectAllPaths(tree).filter((p) => !isCoveredByDeny(p, deny));
}

/** The exclusion frontier: the minimal deny list equivalent to keeping exactly the
 *  included paths. A subtree collapses to ONE deny entry when nothing in it is
 *  included; otherwise we descend so only its un-included branches are denied. A
 *  parent need NOT itself be in the included set for a descendant to survive — which
 *  is how DirectoryTreeSelect reports a partially-ticked parent (child paths present,
 *  parent path absent). Mirror of 06_7/09_7's collectDenyFrontier in _scope.ts. */
function denyFromIncluded(tree: TreeNode[], included: Set<string>, out: string[]): void {
  for (const node of tree) denyNodeFromIncluded(node, included, out);
}

/** Records `node`'s minimal deny frontier into `out`; returns true when the node or
 *  any descendant is included. Bottom-up so a fully-excluded subtree collapses to one
 *  entry, but a single included descendant keeps its branch alive. */
function denyNodeFromIncluded(node: TreeNode, included: Set<string>, out: string[]): boolean {
  const children = node.children ?? [];
  if (children.length === 0) {
    if (included.has(node.path)) return true;
    out.push(node.path);
    return false;
  }
  const childOut: string[] = [];
  let anyKept = included.has(node.path);
  for (const child of children) {
    if (denyNodeFromIncluded(child, included, childOut)) anyKept = true;
  }
  if (!anyKept) {
    out.push(node.path);
    return false;
  }
  out.push(...childOut);
  return true;
}

/** Split total file counts by whether each node is currently included. Each node
 *  contributes its OWN direct fileCount to in-scope or ignored by its membership. */
function fileCountsFromIncluded(
  tree: TreeNode[],
  included: Set<string>,
): { inScope: number; ignored: number } {
  let inScope = 0;
  let ignored = 0;
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (included.has(n.path)) inScope += n.fileCount ?? 0;
      else ignored += n.fileCount ?? 0;
      if (n.children) walk(n.children);
    }
  }
  walk(tree);
  return { inScope, ignored };
}

interface ScopeTreeState {
  tree: TreeNode[];
  included: Set<string>;
}

export default function ReposPage() {
  usePageTitle('Repositories');
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeTreeState | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

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

  // Re-run the clone/copy/scan for a repo whose import failed (status 'error'),
  // e.g. after fixing invalid credentials. refresh-tree resets the repo to
  // 'cloning' and re-enqueues the job, which re-reads the credential fresh.
  async function handleRetry(id: string) {
    try {
      await api.post(`/repos/${id}/refresh-tree`, {});
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to retry clone');
    }
  }

  async function toggleExpand(repo: Repository) {
    if (expandedRepoId === repo.id) {
      setExpandedRepoId(null);
      setScope(null);
      setScopeError(null);
      return;
    }
    setExpandedRepoId(repo.id);
    setScope(null);
    setScopeError(null);
    setScopeLoading(true);
    try {
      const data = await api.get<{ tree: TreeNode[]; scopeExcludeGlobs: string[] }>(
        `/repos/${repo.id}/scope-tree`,
      );
      setScope({
        tree: data.tree,
        included: new Set(includedFromDeny(data.tree, data.scopeExcludeGlobs ?? [])),
      });
    } catch (err) {
      setScopeError((err as Error).message ?? 'Failed to load directory tree');
    } finally {
      setScopeLoading(false);
    }
  }

  async function handleChangeIncluded(repoId: string, includedPaths: string[]) {
    const tree = scope?.tree;
    if (!tree) return;
    const included = new Set(includedPaths);
    setScope((s) => (s ? { ...s, included } : s));
    const deny: string[] = [];
    denyFromIncluded(tree, included, deny);
    try {
      await api.patch(`/repos/${repoId}/exclusions`, { scopeExcludeGlobs: deny.sort() });
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update exclusions');
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
              scope={expandedRepoId === repo.id ? scope : null}
              scopeLoading={expandedRepoId === repo.id && scopeLoading}
              scopeError={expandedRepoId === repo.id ? scopeError : null}
              onExpand={() => toggleExpand(repo)}
              onDelete={() => handleDelete(repo.id)}
              onRetry={() => handleRetry(repo.id)}
              onChangeIncluded={(paths) => handleChangeIncluded(repo.id, paths)}
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
  scope: ScopeTreeState | null;
  scopeLoading: boolean;
  scopeError: string | null;
  onExpand: () => void;
  onDelete: () => void;
  onRetry: () => Promise<void>;
  onChangeIncluded: (paths: string[]) => void;
}

function RepoCard(props: RepoCardProps) {
  const {
    repo,
    expanded,
    scope,
    scopeLoading,
    scopeError,
    onExpand,
    onDelete,
    onRetry,
    onChangeIncluded,
  } = props;

  // The exclusions editor is available once onboarding has produced a scope deny
  // list (scopeExcludeGlobs !== null). Before that there is nothing to edit.
  const canEditScope = repo.status === 'ready' && repo.scopeExcludeGlobs !== null;
  // A ready repo with onboarding markers still absent. Show a yellow badge and
  // route its primary CTA to onboarding — the new-task page auto-selects the
  // onboarding flow for a non-onboarded repo. (undefined = unknown → treat as
  // onboarded so nothing is hidden on a stale payload.)
  const notOnboarded = repo.status === 'ready' && repo.onboarded === false;
  const excludedCount = repo.scopeExcludeGlobs?.length ?? 0;
  const counts = scope ? fileCountsFromIncluded(scope.tree, scope.included) : null;

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  async function handleRetryClick() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  async function downloadArchive() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/repos/${repo.id}/archive`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${repo.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError((err as Error).message ?? 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-neutral-50">{repo.name}</h2>
            <Badge variant={statusVariant(repo.status)}>{repo.status}</Badge>
            {notOnboarded && <Badge variant="warning">not onboarded yet</Badge>}
            {repo.detectedFramework && <Badge>{repo.detectedFramework}</Badge>}
            {excludedCount > 0 && (
              <Badge variant="warning">
                {excludedCount} excluded path{excludedCount === 1 ? '' : 's'}
              </Badge>
            )}
            {repo.openTaskCount > 0 && (
              <Link href={`/tasks?repositoryId=${repo.id}&status=open`}>
                <Badge className="cursor-pointer transition-colors hover:bg-neutral-700">
                  {repo.openTaskCount} open task{repo.openTaskCount === 1 ? '' : 's'}
                </Badge>
              </Link>
            )}
            {repo.activeTaskCount > 0 && (
              <Link href={`/tasks?repositoryId=${repo.id}&status=active`}>
                <Badge
                  variant="info"
                  className="cursor-pointer transition-colors hover:bg-sky-800/60"
                >
                  {repo.activeTaskCount} active
                </Badge>
              </Link>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {repo.localPath ?? repo.remoteUrl ?? '(no path)'}
          </p>
          {repo.statusMessage && <p className="mt-1 text-xs text-red-400">{repo.statusMessage}</p>}
        </div>
        <div className="flex gap-2">
          {notOnboarded && (
            <Link href={`/tasks/new?repositoryId=${repo.id}`}>
              <Button size="sm">Onboard</Button>
            </Link>
          )}
          {repo.status === 'ready' && !notOnboarded && (
            <Link href={`/tasks/new?repositoryId=${repo.id}`}>
              <Button size="sm">Create task</Button>
            </Link>
          )}
          {repo.status === 'ready' && !notOnboarded && (
            <Link href={`/tasks/new?repositoryId=${repo.id}&mode=run_app`}>
              <Button variant="secondary" size="sm">
                Run app
              </Button>
            </Link>
          )}
          {repo.status === 'ready' && !isReadOnlyLocalRepo(repo) && (
            <Link href={`/repos/${repo.id}/terminal`}>
              <Button variant="secondary" size="sm">
                Terminal
              </Button>
            </Link>
          )}
          {repo.status === 'ready' && (
            <Link href={`/repos/${repo.id}/estimates`}>
              <Button variant="secondary" size="sm">
                Estimates
              </Button>
            </Link>
          )}
          {repo.status === 'ready' && (
            <Button variant="secondary" size="sm" onClick={downloadArchive} disabled={downloading}>
              {downloading ? 'Zipping...' : 'Download'}
            </Button>
          )}
          {canEditScope && (
            <Button variant="secondary" size="sm" onClick={onExpand}>
              {expanded ? 'Close' : 'Exclusions'}
            </Button>
          )}
          {repo.status === 'error' && (
            <Button variant="secondary" size="sm" onClick={handleRetryClick} disabled={retrying}>
              {retrying ? 'Retrying...' : 'Retry'}
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      {downloadError && <p className="text-xs text-red-400">{downloadError}</p>}
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
      {repo.status === 'ready' && (
        <UpgradeAvailableBanner repositoryId={repo.id} repositoryName={repo.name} />
      )}
      {repo.status === 'ready' && <ToolingUpgradeBanner repositoryId={repo.id} />}
      {expanded && canEditScope && (
        <div className="mt-2 border-t border-neutral-800 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-100">RAG scope</p>
            {counts && (
              <p className="text-xs text-neutral-400">
                {counts.inScope} file{counts.inScope === 1 ? '' : 's'} in scope
                <span className="text-neutral-600"> · </span>
                {counts.ignored} ignored
              </p>
            )}
          </div>
          <p className="mb-3 text-xs text-neutral-500">
            Ticked directories are indexed into RAG (the cross-task semantic search index). Untick
            built-in / vendored directories (Drupal core, contrib, vendor, node_modules, ...) to
            keep the RAG index focused on this project&apos;s own code. New folders added later are
            included automatically.
          </p>
          {scopeLoading && <p className="text-sm text-neutral-500">Scanning directories...</p>}
          {scopeError && <p className="text-sm text-red-400">{scopeError}</p>}
          {scope && (
            <DirectoryTreeSelect
              tree={scope.tree}
              value={[...scope.included]}
              onChange={(paths) => onChangeIncluded(paths)}
            />
          )}
        </div>
      )}
    </Card>
  );
}
