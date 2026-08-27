'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { LayoutGrid, ListTree, Plus } from 'lucide-react';
import {
  buildPlan,
  createPlanNode,
  getRepoOnboardingStatus,
  getUiPrefs,
  putUiPrefs,
  getPlanOverview,
  getPlanTree,
  searchPlan,
  type PlanNodeDetail,
  type PlanSearchMatch,
  type PlanTreeNode,
  type UiPrefs,
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
import { cn } from '@/lib/cn';
import { usePageTitle } from '@/lib/use-page-title';
import { PlanCardGrid } from '@/components/plan/plan-card-grid';
import { PlanDetailPanel, type PlanPanelTab } from '@/components/plan/plan-detail-panel';
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
  // Fetched only while the plan is empty: it decides whether the "build from
  // the knowledge base" offer can exist at all. Null = unknown, treated as
  // onboarded so nothing hides on a failed check (same stance as the repos
  // page's `onboarded` handling).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [focus, setFocus] = useState<PlanNodeDetail | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [tree, setTree] = useState<PlanTreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which panel tab is open, held HERE because the panel unmounts every time
  // the selection clears — inside it, the choice died with each Escape.
  const [panelTab, setPanelTab] = useState<PlanPanelTab>('details');
  // Mirror for the once-registered ESC listener.
  const selectedIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // The breadcrumb's add-a-child input. Closed by default: it is an action,
  // not a permanent field, and it lives under the crumb whose child it makes.
  const [addingChild, setAddingChild] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PlanSearchMatch[] | null>(null);
  const [buildTaskId, setBuildTaskId] = useState<string | null>(null);

  // Which of the two views the user reads the plan in, and how wide the left
  // pane is. Both are PER-USER preferences, persisted server-side (not per
  // repo, not localStorage — a layout choice should follow the account). The
  // ref holds the last-saved blob so a view switch does not clobber the split
  // and vice versa; `tiles` / 55 are the optimistic defaults shown before the
  // fetch resolves.
  const [view, setView] = useState<'tree' | 'tiles'>('tiles');
  const [splitPct, setSplitPct] = useState(55);
  const [isWide, setIsWide] = useState(false);
  const prefsRef = useRef<UiPrefs>({});
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const splitDragging = useRef(false);
  // Live mirror of splitPct. The release handler reads THIS rather than a
  // setState updater: an updater must be pure, and StrictMode runs it twice,
  // which would fire the PUT twice per drag.
  const splitPctRef = useRef(55);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getUiPrefs().then((p) => {
      if (cancelled) return;
      // MERGE with local precedence, never replace: a pref the user changed
      // while this GET was in flight already sits in the ref, and overwriting
      // it here would drop it from the next PUT (which merges from the ref).
      const merged: UiPrefs = { ...p, ...prefsRef.current };
      prefsRef.current = merged;
      if (merged.planView === 'tree' || merged.planView === 'tiles') setView(merged.planView);
      if (
        merged.planTab === 'details' ||
        merged.planTab === 'links' ||
        merged.planTab === 'chat' ||
        merged.planTab === 'impact'
      ) {
        setPanelTab(merged.planTab);
      }
      if (typeof merged.planSplitPct === 'number') {
        const clamped = Math.min(80, Math.max(20, merged.planSplitPct));
        splitPctRef.current = clamped;
        setSplitPct(clamped);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // ESC closes the detail panel. Ignored while the user is typing in a field —
  // an ESC meant to clear/leave an input must not also throw away an unsaved
  // body draft in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !selectedIdRef.current) return;
      // A dialog on top owns Escape — closing it and the panel underneath on
      // one press loses work the user never asked to discard.
      if (document.querySelector('[data-haive-dialog]')) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const persistPrefs = useCallback((next: UiPrefs) => {
    prefsRef.current = next;
    void putUiPrefs(next);
  }, []);

  const switchView = useCallback(
    (v: 'tree' | 'tiles') => {
      setView(v);
      persistPrefs({ ...prefsRef.current, planView: v });
    },
    [persistPrefs],
  );

  // Splitter drag: pct updates live (cheap state), the WRITE happens on release
  // only — a drag fires dozens of moves and each would be a PUT.
  const onSplitterDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    splitDragging.current = true;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSplitterMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!splitDragging.current || !splitHostRef.current) return;
    const rect = splitHostRef.current.getBoundingClientRect();
    const pct = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
    splitPctRef.current = pct;
    setSplitPct(pct);
  };
  const endSplitterDrag = (persist: boolean): void => {
    if (!splitDragging.current) return;
    splitDragging.current = false;
    setDragging(false);
    if (persist) {
      persistPrefs({ ...prefsRef.current, planSplitPct: Math.round(splitPctRef.current) });
    }
  };
  const onSplitterUp = (): void => endSplitterDrag(true);
  // A cancelled pointer (interrupted touch, stolen focus) never fires pointerup.
  // Without this the drag flag sticks and later moves resize with no button held.
  const onSplitterCancel = (): void => endSplitterDrag(false);

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

  // Only asked once the repo is known to have no plan — the answer changes
  // nothing while a plan exists.
  useEffect(() => {
    if (nodeCount !== 0) return;
    let cancelled = false;
    void getRepoOnboardingStatus(repositoryId)
      .then((s) => !cancelled && setOnboarded(s.onboarded))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nodeCount, repositoryId]);

  const descend = useCallback(
    async (nodeId: string) => {
      setError(null);
      try {
        setFocus(await getPlanNode(repositoryId, nodeId));
        // Every way of moving to a node — a tree row, a breadcrumb, an impact
        // hop, a card's Open — leaves the panel open on the node moved to. One
        // rule: the panel describes wherever you just went.
        setSelectedId(nodeId);
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
      setAddingChild(false);
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

  selectedIdRef.current = selectedId;

  // The tree filters on match IDS, not the match payloads — the tree rows
  // already carry their own titles, and only visibility is in question.
  const matchIds = useMemo(() => (matches ? new Set(matches.map((m) => m.id)) : null), [matches]);

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
            {/* A repo that was never onboarded has no knowledge base to build
                from — only the by-hand starter exists for it. */}
            {onboarded !== false && (
              <Button size="sm" disabled={busy} onClick={() => void build('from_repo')}>
                Build from the knowledge base
              </Button>
            )}
            <div className="flex gap-2">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={
                  onboarded === false
                    ? 'Name the project to start creating its plan/map'
                    : 'Or name the project to start by hand'
                }
                className={onboarded === false ? 'w-96' : 'w-72'}
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
        <div ref={splitHostRef} className="flex flex-col gap-4 lg:flex-row lg:gap-0">
          {/* Left pane: the ACTIVE view — tree or tiles, never both. The two
              read the plan differently (outline vs drill-down), so they are
              alternate views of the same left column, not two side-by-side
              surfaces. */}
          <section
            className={`flex min-w-0 flex-col gap-3 ${selectedId ? 'lg:shrink-0' : 'flex-1'}`}
            style={isWide && selectedId ? { width: `${splitPct}%` } : undefined}
          >
            {/* View switcher. `title` carries the tooltip; aria-pressed says
                which is active to something reading the page. */}
            <div className="flex items-center justify-between gap-2">
              <div
                role="group"
                aria-label="Plan view"
                className="flex overflow-hidden rounded-md border border-neutral-800"
              >
                <button
                  type="button"
                  title="Tree view — the whole hierarchy as an outline"
                  aria-pressed={view === 'tree'}
                  onClick={() => switchView('tree')}
                  className={`flex h-8 w-9 items-center justify-center ${
                    view === 'tree'
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-neutral-500 hover:text-neutral-200'
                  }`}
                >
                  <ListTree className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="Tiles view — drill down one level at a time"
                  aria-pressed={view === 'tiles'}
                  onClick={() => switchView('tiles')}
                  className={`flex h-8 w-9 items-center justify-center border-l border-neutral-800 ${
                    view === 'tiles'
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-neutral-500 hover:text-neutral-200'
                  }`}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              </div>
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

            {view === 'tree' ? (
              <div className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 py-2">
                <PlanTree
                  nodes={tree}
                  selectedId={selectedId}
                  matchIds={matchIds}
                  onSelect={(id) => {
                    // Clicking the ALREADY-selected row closes the panel — same
                    // contract as clicking a selected tile. Otherwise the click
                    // both selects (right panel follows) and focuses (children
                    // load, so a later switch to tiles is where you left off).
                    if (id === selectedId) {
                      setSelectedId(null);
                      return;
                    }
                    setSelectedId(id);
                    void descend(id);
                  }}
                />
              </div>
            ) : (
              <>
                <nav className="flex flex-wrap items-center gap-1 text-xs text-neutral-400">
                  {crumbs.map((crumb, i) => (
                    <span key={crumb.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-neutral-700">/</span>}
                      <button
                        type="button"
                        onClick={() => {
                          setMatches(null);
                          void descend(crumb.id);
                        }}
                        className={
                          i === crumbs.length - 1 ? 'text-neutral-100' : 'hover:text-neutral-100'
                        }
                      >
                        {crumb.title}
                      </button>
                    </span>
                  ))}
                  {/* Adds a child of the node the breadcrumb ENDS on — the one
                      whose children the grid is showing. Hidden while a search
                      filters the grid, since the crumb is then not what is
                      listed below it. */}
                  {!matches && currentParentId && (
                    <button
                      type="button"
                      title="Add a new child"
                      aria-label="Add a new child"
                      onClick={() => {
                        setNewTitle('');
                        setAddingChild((v) => !v);
                      }}
                      className="ml-2.5 text-neutral-500 hover:text-neutral-200"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </nav>

                {addingChild && !matches && (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTitle.trim()) void addNode(currentParentId);
                        // Escape closes the adder. The page-level ESC handler
                        // ignores INPUT targets, so the panel stays open.
                        if (e.key === 'Escape') {
                          setNewTitle('');
                          setAddingChild(false);
                        }
                      }}
                      placeholder="Name the new child"
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      size="sm"
                      disabled={busy || !newTitle.trim()}
                      onClick={() => void addNode(currentParentId)}
                    >
                      OK
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setNewTitle('');
                        setAddingChild(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}

                <PlanCardGrid
                  nodes={cards}
                  selectedId={selectedId}
                  onSelect={(n) => setSelectedId((prev) => (prev === n.id ? null : n.id))}
                  onDescend={(n) => {
                    // Descending replaces the card list with one node's
                    // children, so an active filter must not survive it.
                    setMatches(null);
                    void descend(n.id);
                  }}
                  emptyMessage={
                    matches
                      ? 'Nothing matched.'
                      : 'Nothing under this node yet — add a child with the + beside the breadcrumb, or ask a plan chat to break it down.'
                  }
                />
              </>
            )}
          </section>

          {/* Splitter — only while the detail panel is open; with no right pane
              it would dangle beside empty space. Wide screens only; stacked
              panes have nothing to resize. */}
          {selectedId && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize plan panes"
              onPointerDown={onSplitterDown}
              onPointerMove={onSplitterMove}
              onPointerUp={onSplitterUp}
              onPointerCancel={onSplitterCancel}
              className={cn(
                'hidden w-1.5 shrink-0 cursor-col-resize transition-colors lg:block',
                // Mutually exclusive branches: a ref cannot re-render, and a
                // second bg-* in one string is resolved by stylesheet order,
                // not by where it sits in the string.
                dragging ? 'bg-indigo-500/60' : 'bg-neutral-800 hover:bg-indigo-500/60',
              )}
            />
          )}

          {/* Right pane: the selected node's details — rendered only while a
              node is selected; closed, the view takes the full width and the
              splitter goes with it. */}
          {selectedId && (
            <section
              className="min-w-0 flex-1"
              style={
                isWide
                  ? ({ width: `${100 - splitPct}%`, flex: 'none' } as CSSProperties)
                  : undefined
              }
            >
              <PlanDetailPanel
                repositoryId={repositoryId}
                nodeId={selectedId}
                tree={tree}
                tab={panelTab}
                onTabChange={(t) => {
                  setPanelTab(t);
                  persistPrefs({ ...prefsRef.current, planTab: t });
                }}
                onChanged={() => void refresh()}
                onNavigate={(id) => void descend(id)}
                onClose={() => setSelectedId(null)}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
