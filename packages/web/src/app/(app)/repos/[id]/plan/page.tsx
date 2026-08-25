'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  buildPlan,
  createPlanNode,
  getPlanOverview,
  getPlanTree,
  searchPlan,
  type PlanNodeDetail,
  type PlanSearchMatch,
  type PlanTreeNode,
} from '@/lib/api-client';
import { getPlanNode } from '@/lib/api-client';
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
} from '@/components/ui';
import { usePageTitle } from '@/lib/use-page-title';
import { PlanCardGrid } from '@/components/plan/plan-card-grid';
import { PlanDetailPanel } from '@/components/plan/plan-detail-panel';
import { PlanTree } from '@/components/plan/plan-tree';

/**
 * The plan canvas.
 *
 * Drill-down, not a viewport: a breadcrumb plus one level of cards. Descending
 * fetches that level alone, so a 400-node plan never arrives in the browser at
 * once — only the hierarchy-only tree does, and that carries no bodies.
 */
export default function PlanPage() {
  usePageTitle('Plan');
  const params = useParams();
  const repositoryId = String(params.id);

  const [repoName, setRepoName] = useState('');
  const [nodeCount, setNodeCount] = useState(0);
  const [focus, setFocus] = useState<PlanNodeDetail | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [tree, setTree] = useState<PlanTreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PlanSearchMatch[] | null>(null);
  const [buildTaskId, setBuildTaskId] = useState<string | null>(null);

  const loadRoot = useCallback(async (): Promise<string | null> => {
    const [overview, treeRes] = await Promise.all([
      getPlanOverview(repositoryId),
      getPlanTree(repositoryId),
    ]);
    setRepoName(overview.repositoryName);
    setNodeCount(overview.nodeCount);
    setRootId(overview.root?.id ?? null);
    setTree(treeRes.nodes);
    return overview.root?.id ?? null;
  }, [repositoryId]);

  const refresh = useCallback(async () => {
    // A plan chat rooted anywhere may patch anywhere, so a refresh reloads the
    // whole visible surface rather than just the node that was edited.
    const root = await loadRoot();
    const target = focus?.node.id ?? root;
    if (!target) {
      setFocus(null);
      setSelectedId(null);
      return;
    }
    try {
      setFocus(await getPlanNode(repositoryId, target));
    } catch {
      // The focused node was deleted (its own delete, or an ancestor's). Fall
      // back to the root rather than render a node that no longer exists.
      setFocus(root ? await getPlanNode(repositoryId, root) : null);
      setSelectedId(null);
    }
  }, [loadRoot, focus, repositoryId]);

  useEffect(() => {
    let cancelled = false;
    void loadRoot()
      .then(async (root) => {
        // The root is focused immediately rather than treated as a special
        // "no focus" state. Without it the root is the one node that can never
        // be selected, so its own description, status and chat are unreachable.
        if (root && !cancelled) setFocus(await getPlanNode(repositoryId, root));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [loadRoot, repositoryId]);

  const descend = useCallback(
    async (nodeId: string) => {
      setError(null);
      try {
        setFocus(await getPlanNode(repositoryId, nodeId));
        setSelectedId(nodeId);
        setMatches(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to open node');
      }
    },
    [repositoryId],
  );

  async function runSearch() {
    const q = query.trim();
    if (q.length < 2) {
      setMatches(null);
      return;
    }
    try {
      setMatches((await searchPlan(repositoryId, q)).matches);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    }
  }

  async function addNode(parentId: string | null) {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      await createPlanNode(repositoryId, { parentId, title });
      setNewTitle('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setBusy(false);
    }
  }

  async function build(mode: 'from_repo' | 'from_md') {
    setBusy(true);
    setError(null);
    try {
      const { taskId } = await buildPlan(repositoryId, { mode });
      setBuildTaskId(taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the build');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading plan…</p>;

  const currentParentId = focus?.node.id ?? rootId;
  const cards = matches ?? focus?.children ?? [];
  const crumbs = focus?.ancestry ?? [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">
            Plan{repoName && <span className="text-neutral-500"> — {repoName}</span>}
          </h1>
          <p className="text-xs text-neutral-500">
            {nodeCount} node{nodeCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/repos`}>
            <Button size="sm" variant="ghost">
              Back to repositories
            </Button>
          </Link>
        </div>
      </div>

      <FormError message={error} />

      {buildTaskId && (
        <p className="rounded border border-indigo-900 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
          Building the plan —{' '}
          <Link href={`/tasks/${buildTaskId}`} className="underline">
            watch the task
          </Link>
          . Reload this page when it finishes.
        </p>
      )}

      {nodeCount === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No plan yet</CardTitle>
            <CardDescription>
              A plan is a durable tree of what this project is meant to be, drilling down from the
              whole product to leaves you can turn into tasks. Derive one from the repository&apos;s
              knowledge base, or start it by hand.
            </CardDescription>
          </CardHeader>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void build('from_repo')}>
              Build from the knowledge base
            </Button>
            <div className="flex gap-2">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Or name the project to start by hand"
                className="w-72"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !newTitle.trim()}
                onClick={() => void addNode(null)}
              >
                Create
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr] xl:grid-cols-[220px_1fr_360px]">
          <div className="hidden max-h-[70vh] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 py-2 lg:block">
            <PlanTree nodes={tree} selectedId={selectedId} onSelect={(id) => void descend(id)} />
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <nav className="flex flex-1 flex-wrap items-center gap-1 text-xs text-neutral-400">
                {crumbs.map((crumb, i) => (
                  <span key={crumb.id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-neutral-700">/</span>}
                    <button
                      type="button"
                      onClick={() => void descend(crumb.id)}
                      className={
                        i === crumbs.length - 1 ? 'text-neutral-100' : 'hover:text-neutral-100'
                      }
                    >
                      {crumb.title}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="flex gap-1">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
                  placeholder="Search the plan"
                  className="h-8 w-48 text-xs"
                />
                {matches && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setMatches(null);
                      setQuery('');
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>

            {matches && (
              <p className="text-xs text-neutral-500">
                {matches.length} match{matches.length === 1 ? '' : 'es'} anywhere in the plan
              </p>
            )}

            <PlanCardGrid
              nodes={cards}
              selectedId={selectedId}
              onSelect={(n) => setSelectedId(n.id)}
              onDescend={(n) => void descend(n.id)}
              emptyMessage={
                matches
                  ? 'Nothing matched.'
                  : 'Nothing under this node yet — add a child below, or ask a plan chat to break it down.'
              }
            />

            {!matches && (
              <div className="flex gap-2">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Add a child here"
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !newTitle.trim()}
                  onClick={() => void addNode(currentParentId)}
                >
                  Add
                </Button>
              </div>
            )}
          </div>

          {selectedId && (
            <div className="xl:sticky xl:top-4 xl:self-start">
              <PlanDetailPanel
                repositoryId={repositoryId}
                nodeId={selectedId}
                tree={tree}
                onChanged={() => void refresh()}
                onNavigate={(id) => void descend(id)}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
