'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CloudDownload,
  CloudUpload,
  LayoutGrid,
  ListOrdered,
  ListTree,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import {
  createPlanNode,
  deletePlanEdge,
  getPlanUnread,
  getRepoOnboardingStatus,
  getUiPrefs,
  putUiPrefs,
  getPlanOverview,
  getPlanTree,
  getPlanSnapshot,
  pullPlanSnapshot,
  savePlanSnapshot,
  searchPlan,
  startPlanSequence,
  type PlanNodeDetail,
  type PlanSearchMatch,
  type PlanTreeNode,
  type PlanDefects,
  type PlanPullOutcome,
  type PlanSnapshotHealth,
  type UiPrefs,
} from '@/lib/api-client';
import { getPlanNode } from '@/lib/api-client';
import { Button, FormError, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { usePageTitle } from '@/lib/use-page-title';
import { PlanCardGrid } from '@/components/plan/plan-card-grid';
import { PlanDetailPanel, type PlanPanelTab } from '@/components/plan/plan-detail-panel';
import { PlanTree } from '@/components/plan/plan-tree';
import { PlanDeleteDialog } from '@/components/plan/plan-delete-dialog';
import { PlanStarter } from '@/components/plan/plan-starter';

/**
 * The plan canvas.
 *
 * Drill-down, not a viewport: a breadcrumb plus one level of cards. Descending
 * fetches that level alone, so a 400-node plan never arrives in the browser at
 * once — only the hierarchy-only tree does, and that carries no bodies.
 */
/** How often unread badges are re-read while the plan is open. Slow on purpose:
 *  it answers "did a reply land somewhere else", which is a matter of seconds
 *  mattering to nobody, and the query runs for every node of the repo. */
const UNREAD_POLL_MS = 15_000;
const SNAPSHOT_POLL_MS = 10_000;

export default function PlanPage() {
  usePageTitle('Plan');
  const params = useParams();
  const router = useRouter();
  const repositoryId = String(params.id);
  // The selected node lives in the URL, not in preferences: it is per-repo by
  // construction, it survives a reload, and Back from the new-task form returns
  // to the node the task was created from. Read once, at mount — after that the
  // page owns the selection and writes it back.
  //
  // Read through the browser rather than useSearchParams(): that hook opts the
  // route out of static rendering unless it sits under a Suspense boundary, and
  // this needs neither router state nor a re-render to answer.
  const initialNodeRef = useRef<string | null>(
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('node'),
  );

  const [repoName, setRepoName] = useState('');
  const [nodeCount, setNodeCount] = useState(0);
  // Dependency knots, from the overview. A property of the PLAN rather than of
  // any node — a cycle has two ends and neither is the place to report it — so
  // it is surfaced once here rather than on every node it touches.
  const [defects, setDefects] = useState<PlanDefects | null>(null);
  const [defectsOpen, setDefectsOpen] = useState(false);
  const [sequencing, setSequencing] = useState(false);
  const [pullReport, setPullReport] = useState<PlanPullOutcome | null>(null);
  const [removingEdge, setRemovingEdge] = useState(false);
  // Fetched only while the plan is empty: it decides whether the "build from
  // the knowledge base" offer can exist at all. Null = unknown, treated as
  // onboarded so nothing hides on a failed check (same stance as the repos
  // page's `onboarded` handling).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [focus, setFocus] = useState<PlanNodeDetail | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [tree, setTree] = useState<PlanTreeNode[]>([]);
  // Unread assistant turns per node. Its own fetch rather than a field on the
  // tree: the same map badges the tree, the tiles and the panel's Chat tab.
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which panel tab is open, held HERE because the panel unmounts every time
  // the selection clears — inside it, the choice died with each Escape.
  const [panelTab, setPanelTab] = useState<PlanPanelTab>('details');
  // Mirror for the once-registered ESC listener.
  const selectedIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<PlanSnapshotHealth | null>(null);
  const [newTitle, setNewTitle] = useState('');
  // The breadcrumb's add-a-child input. Closed by default: it is an action,
  // not a permanent field, and it lives under the crumb whose child it makes.
  const [addingChild, setAddingChild] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PlanSearchMatch[] | null>(null);

  // Which of the two views the user reads the plan in, and how wide the left
  // pane is. Both are PER-USER preferences, persisted server-side (not per
  // repo, not localStorage — a layout choice should follow the account). The
  // ref holds the last-saved blob so a view switch does not clobber the split
  // and vice versa; `tiles` / 55 are the optimistic defaults shown before the
  // fetch resolves.
  const [view, setView] = useState<'tree' | 'tiles'>('tiles');
  const [deleting, setDeleting] = useState(false);
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

  // Unread badges are a NOTIFICATION surface: a reply that arrives while the
  // user is reading a different node has to show up on its own, and a plan chat
  // deliberately raises no toast to announce it. The chat panel only polls the
  // node it is open on, so without this a badge for any other node waited for a
  // manual refresh. One aggregate query, and only while the tab is visible.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      if (document.hidden) return;
      void getPlanUnread(repositoryId)
        .then((u) => !cancelled && setUnread(u.counts))
        .catch(() => {});
    };
    const timer = setInterval(load, UNREAD_POLL_MS);
    // Coming back to the tab should not wait out the interval.
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [repositoryId]);

  // File reconciliation is asynchronous: an API edit commits the DB revision,
  // then wakes the worker. Poll just the compact health endpoint so the header
  // moves from "updating" to "ready to commit" without reloading the plan.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      if (document.hidden) return;
      void getPlanSnapshot(repositoryId)
        .then((value) => !cancelled && setSnapshot(value))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, SNAPSHOT_POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [repositoryId]);

  const loadRoot = useCallback(async (): Promise<string | null> => {
    const [overview, treeRes] = await Promise.all([
      getPlanOverview(repositoryId),
      getPlanTree(repositoryId),
      // Best-effort: a badge that fails to load must not stop the plan
      // rendering.
      getPlanUnread(repositoryId)
        .then((u) => setUnread(u.counts))
        .catch(() => {}),
    ]);
    setRepoName(overview.repositoryName);
    setNodeCount(overview.nodeCount);
    setDefects(overview.defects ?? null);
    setRootId(overview.root?.id ?? null);
    setTree(treeRes.nodes);
    return overview.root?.id ?? null;
  }, [repositoryId]);

  async function saveSnapshot(push: boolean): Promise<void> {
    setSnapshotBusy(true);
    setError(null);
    try {
      await savePlanSnapshot(repositoryId, { push });
      setSnapshot(await getPlanSnapshot(repositoryId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the plan snapshot');
    } finally {
      setSnapshotBusy(false);
    }
  }

  /** Delete one dependency edge from the defect report. Never automatic: the
   *  plan says two things depend on each other and only a person knows which of
   *  them is the wrong claim. */
  async function removeDefectEdge(edgeId: string): Promise<void> {
    setRemovingEdge(true);
    setError(null);
    try {
      await deletePlanEdge(repositoryId, edgeId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the dependency');
    } finally {
      setRemovingEdge(false);
    }
  }

  async function pullSnapshot(): Promise<void> {
    // Confirmed, unlike Save: this is the one control that changes the local
    // plan from outside, and the checkout moves with it.
    if (
      !window.confirm(
        'Pull the latest commits and merge the committed plan into this one?\n\n' +
          'Nodes are added and updated. Nodes that exist only here are KEPT, never deleted — ' +
          'you will be told which.',
      )
    ) {
      return;
    }
    setSnapshotBusy(true);
    setError(null);
    setPullReport(null);
    try {
      const result = await pullPlanSnapshot(repositoryId);
      setPullReport(result.pulled ?? null);
      setSnapshot(await getPlanSnapshot(repositoryId));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to pull the plan snapshot');
    } finally {
      setSnapshotBusy(false);
    }
  }

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
        if (cancelled) return;
        // A node named in the URL wins over the root. A stale one — deleted, or
        // belonging to a plan that has since been rebuilt — falls back to the
        // root rather than leaving the page empty on a bad link.
        const wanted = initialNodeRef.current;
        if (wanted) {
          try {
            setFocus(await getPlanNode(repositoryId, wanted));
            if (!cancelled) setSelectedId(wanted);
            return;
          } catch {
            initialNodeRef.current = null;
          }
        }
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

  selectedIdRef.current = selectedId;

  // Mirror the selection into the URL. replaceState, not a push: browsing the
  // plan is not a history trail, and a push per click would make Back mean
  // "undo one selection" instead of "leave the plan".
  useEffect(() => {
    if (loading) return;
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set('node', selectedId);
    else url.searchParams.delete('node');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [selectedId, loading]);

  // The tree filters on match IDS, not the match payloads — the tree rows
  // already carry their own titles, and only visibility is in question.
  const matchIds = useMemo(() => (matches ? new Set(matches.map((m) => m.id)) : null), [matches]);

  if (loading) return <p className="p-6 text-sm text-neutral-500">Loading plan…</p>;

  const currentParentId = focus?.node.id ?? rootId;
  const cards = matches ?? focus?.children ?? [];
  const crumbs = focus?.ancestry ?? [];
  const defectCount = (defects?.cycles.length ?? 0) + (defects?.ancestorDeps.length ?? 0);

  const snapshotLabel = !snapshot
    ? 'Checking snapshot…'
    : snapshot.lastError
      ? 'Snapshot error'
      : !snapshot.snapshotWritten
        ? 'Snapshot updating…'
        : !snapshot.committed
          ? 'Not committed'
          : snapshot.pushed === true
            ? 'Committed and pushed'
            : snapshot.pushed === false
              ? 'Committed, not pushed'
              : 'Committed';

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-neutral-100">
            Plan{repoName && <span className="text-neutral-500"> — {repoName}</span>}
            {/* An icon, not a red button: the weight of this belongs in the
                confirmation, not in a control someone brushes past. Hidden
                entirely when there is no plan — an affordance that deletes
                nothing is just a question mark. */}
            {nodeCount > 0 && (
              <button
                type="button"
                onClick={() => setDeleting(true)}
                title="Delete this plan"
                aria-label="Delete this plan"
                className="text-neutral-500 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </h1>
          <p className="text-xs text-neutral-500">
            {nodeCount} node{nodeCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          {(nodeCount > 0 || snapshot?.lastError) && (
            <span
              title={snapshot?.lastError ?? 'Repository-backed plan snapshot status'}
              className={`self-center text-xs ${
                snapshot?.lastError
                  ? 'text-red-400'
                  : snapshot?.committed
                    ? 'text-emerald-400'
                    : 'text-amber-400'
              }`}
            >
              {snapshotLabel}
            </span>
          )}
          {nodeCount > 0 && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={sequencing}
                onClick={() => {
                  void (async () => {
                    setError(null);
                    setSequencing(true);
                    try {
                      const { taskId } = await startPlanSequence(repositoryId);
                      router.push(`/tasks/${taskId}`);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not start the ordering run');
                      setSequencing(false);
                    }
                  })();
                }}
                title="Order every group of sibling nodes so the plan can be followed by number"
              >
                <ListOrdered className="mr-1 h-3.5 w-3.5" />
                {sequencing ? 'Starting…' : 'Order the plan'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={snapshotBusy}
                onClick={() => void saveSnapshot(false)}
                title="Refresh and commit plan.json plus the full plan.md"
              >
                <Save className="mr-1 h-3.5 w-3.5" />
                Save plan
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={snapshotBusy}
                onClick={() => void saveSnapshot(true)}
                title="Refresh, commit and push the portable plan snapshot"
              >
                <CloudUpload className="mr-1 h-3.5 w-3.5" />
                Save &amp; push
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={snapshotBusy}
                onClick={() => void pullSnapshot()}
                title="Fast-forward this checkout from origin and merge the committed plan into this one"
              >
                <CloudDownload className="mr-1 h-3.5 w-3.5" />
                Pull
              </Button>
            </>
          )}
          <Link href={`/repos`}>
            <Button size="sm" variant="ghost">
              Back to repositories
            </Button>
          </Link>
        </div>
      </div>

      <FormError message={error} />
      <FormError message={snapshot?.lastError ? `Plan snapshot: ${snapshot.lastError}` : null} />

      {pullReport && (
        <div className="flex flex-col gap-1 rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">
          {pullReport.skipped ? (
            <p>Nothing to merge: {pullReport.skipped}.</p>
          ) : (
            <>
              <p>
                Pulled{pullReport.fastForwarded ? ' new commits' : ' (already up to date)'}:{' '}
                {pullReport.nodesCreated} node(s) added, {pullReport.nodesUpdated} updated,{' '}
                {pullReport.edgesAdded} link(s) added.
              </p>
              {pullReport.keptLocal.length > 0 && (
                // Named rather than merely counted: these are the nodes the merge
                // could not decide about, and the user is the one who can.
                <p>
                  {pullReport.keptLocal.length} node(s) exist only here and were KEPT. They are
                  either yours and unpushed, or removed on the other side — delete them by hand if
                  the removal was intended.
                </p>
              )}
              {pullReport.previousCommit && (
                <p className="text-neutral-500">
                  Checkout was at {pullReport.previousCommit.slice(0, 12)} before this.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {defects && defectCount > 0 && (
        // Red, unlike the "waiting on" notices: these dependencies can NEVER be
        // satisfied, so the nodes on them are not waiting for anything — they
        // are stuck until a person deletes an edge. Reporting them as ordinary
        // blocking would hide that difference behind identical wording.
        //
        // Collapsed by default and it stays a summary until asked: MEASURED on
        // this install, one plan carries 16, which unrolled is a wall of text
        // above the tree the page is actually for.
        <div className="flex flex-col gap-1 rounded border border-red-900 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          <button
            type="button"
            onClick={() => setDefectsOpen((v) => !v)}
            className="text-left font-medium"
          >
            {defectsOpen ? '▾' : '▸'} This plan has {defectCount}{' '}
            {defectCount === 1 ? 'dependency' : 'dependencies'} that can never be satisfied. Every
            node on one stays blocked until an edge is removed.
          </button>
          {defectsOpen && (
            <>
              {defects.cycles.map((loop, i) => (
                <div
                  key={loop.map((h) => h.from.nodeId).join('-')}
                  className="flex flex-col gap-0.5"
                >
                  <p>Loop {i + 1} — remove any ONE of these to break it:</p>
                  {loop.map((hop) => (
                    <p key={`${hop.from.nodeId}-${hop.to.nodeId}`} className="pl-3">
                      #{hop.from.sequence} {hop.from.title} → #{hop.to.sequence} {hop.to.title}
                      <DefectEdgeRemove
                        edgeId={hop.edgeId}
                        busy={removingEdge}
                        onRemove={removeDefectEdge}
                      />
                    </p>
                  ))}
                </div>
              ))}
              {defects.ancestorDeps.map((hop) => (
                <p key={`${hop.from.nodeId}-${hop.to.nodeId}`}>
                  #{hop.from.sequence} {hop.from.title} depends on its own parent #{hop.to.sequence}{' '}
                  {hop.to.title}, which cannot finish first.
                  <DefectEdgeRemove
                    edgeId={hop.edgeId}
                    busy={removingEdge}
                    onRemove={removeDefectEdge}
                  />
                </p>
              ))}
            </>
          )}
        </div>
      )}

      {nodeCount === 0 ? (
        <PlanStarter
          repositoryId={repositoryId}
          onboarded={onboarded}
          onNavigate={(href) => router.push(href)}
          onCreateRoot={async (title) => {
            setError(null);
            try {
              await createPlanNode(repositoryId, { parentId: null, title });
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to add');
            }
          }}
        />
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
                  unread={unread}
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
                  unread={unread}
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
                unreadCount={unread[selectedId] ?? 0}
                onRead={() => {
                  // Clear this node's badge as soon as the panel says it was
                  // read, then re-read the map so the tree and tiles agree.
                  setUnread((prev) => {
                    if (!prev[selectedId]) return prev;
                    const next = { ...prev };
                    delete next[selectedId];
                    return next;
                  });
                  void getPlanUnread(repositoryId)
                    .then((u) => setUnread(u.counts))
                    .catch(() => {});
                }}
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

      <PlanDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        repositoryId={repositoryId}
        repoName={repoName}
        nodeCount={nodeCount}
        onDeleted={() => {
          // Clear the selection before refreshing: the panel is showing a node
          // that no longer exists, and reloading it would 404 before the grid
          // ever got the chance to redraw as empty.
          setSelectedId(null);
          void refresh();
        }}
      />
    </div>
  );
}

/** The "remove this dependency" affordance on a defect line.
 *
 *  Its own component only because it appears once per hop of every loop and once
 *  per ancestor dependency, and repeating the confirm text at each site is how
 *  two of them come to say different things.
 *
 *  Confirmed, and never automatic: the plan is asserting that two things depend
 *  on each other, and only a person knows which of the two claims is the wrong
 *  one. Removing the edge the code happened to walk first would be a guess
 *  written into the plan. */
function DefectEdgeRemove({
  edgeId,
  busy,
  onRemove,
}: {
  edgeId: string | null;
  busy: boolean;
  onRemove: (edgeId: string) => Promise<void>;
}) {
  // A hop whose edge vanished between the read and the render is stale, not
  // broken — offering a button that deletes nothing would be worse than none.
  if (!edgeId) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!window.confirm('Remove this dependency? The nodes stay; only the link goes.')) return;
        void onRemove(edgeId);
      }}
      className="ml-2 underline disabled:opacity-50"
    >
      remove
    </button>
  );
}
