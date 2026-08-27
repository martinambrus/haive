'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import {
  createPlanEdge,
  createPlanNode,
  deletePlanEdge,
  deletePlanNode,
  getPlanImpact,
  getPlanNode,
  startPlanAdvisory,
  updatePlanNode,
  type PlanEdgeKind,
  type PlanImpact,
  type PlanNodeDetail,
  type PlanNodeStatus,
  type PlanTreeNode,
} from '@/lib/api-client';
import { Badge, Button, FormError } from '@/components/ui';
import { CodePreviewDialog } from '@/components/code-preview-dialog';
import { MarkdownEditor } from '@/components/markdown/markdown-editor';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { looksLikeMarkdown } from '@/components/markdown/looks-like-markdown';
import { groupPlanEdges } from './plan-edge-groups';
import {
  DEFAULT_IMPACT_DEPTH,
  IMPACT_DEPTH_CHOICES,
  defaultOpenImpactDepths,
  groupImpactHops,
} from './plan-impact-groups';
import { PlanChat } from './plan-chat';
import { PlanGraph } from './plan-graph';
import {
  PLAN_KINDS,
  PLAN_STATUSES,
  isRolledUp,
  kindLabel,
  statusBadge,
  statusLabel,
} from './plan-status';

export type PlanPanelTab = 'details' | 'links' | 'chat' | 'impact';

/**
 * Everything about one node, in a panel beside the grid.
 *
 * It is also the tablet-friendly home for actions that are hover affordances on
 * a card — a touch device has no hover, so every action a card offers has to
 * exist here too.
 *
 * Every write states the `expectedVersion` it read. A plan chat can patch this
 * node at any moment, so a 409 is an expected outcome and is SHOWN: silently
 * refetching would discard the user's edit without telling them it happened.
 */
export function PlanDetailPanel({
  repositoryId,
  nodeId,
  tree,
  tab,
  onTabChange,
  unreadCount,
  onRead,
  onChanged,
  onNavigate,
  onClose,
}: {
  repositoryId: string;
  nodeId: string;
  tree: PlanTreeNode[];
  /** Unread chat replies on THIS node, badged on the Chat tab so the badge in
   *  the tree has a visible destination. */
  unreadCount: number;
  /** The chat marked itself read; the page re-reads the counts. */
  onRead: () => void;
  /** Owned by the page, not by this component: the panel unmounts whenever the
   *  selection clears (Escape, or clicking the selected node again), and a tab
   *  kept here would be forgotten every time that happened. */
  tab: PlanPanelTab;
  onTabChange: (tab: PlanPanelTab) => void;
  onChanged: () => void;
  onNavigate: (nodeId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<PlanNodeDetail | null>(null);
  const [impact, setImpact] = useState<PlanImpact | null>(null);
  // The radius the Impact tab opens at. One hop, because on a real plan two
  // reach a median of 130 nodes — a transitive answer is "the whole plan".
  const [impactDepth, setImpactDepth] = useState<number>(DEFAULT_IMPACT_DEPTH);
  const [openImpactDepths, setOpenImpactDepths] = useState<Set<number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  // Add-a-child, available from the panel in BOTH views — the tiles
  // breadcrumb can only add under the node it ends on, so a node reached by
  // clicking a tile or a tree row has no other way to gain a child.
  const [addingChild, setAddingChild] = useState(false);
  // EXPLICIT fold choices only, keyed by group id (true = open). Absent means
  // "as it comes": a group with links opens, an empty one stays folded, since
  // an empty group is a control to add one rather than something to read.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  // The code link being previewed, or null. Held here rather than per row so
  // only one file is ever fetched and mounted.
  const [preview, setPreview] = useState<{
    repoPath: string;
    symbol: string | null;
    evidence: string | null;
  } | null>(null);
  const [childTitle, setChildTitle] = useState('');
  const [statusDraft, setStatusDraft] = useState<PlanNodeStatus>('todo');
  const [kindDraft, setKindDraft] = useState<PlanNodeDetail['node']['kind']>('component');
  const [bodyDraft, setBodyDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  // Which group's add-a-link row is open, as `<kind>:<dir>`. One at a time.
  const [addingLinkTo, setAddingLinkTo] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    const d = await getPlanNode(repositoryId, nodeId);
    setDetail(d);
    setTitleDraft(d.node.title);
    setBodyDraft(d.node.body ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    // The TAB deliberately survives a node change: someone comparing links (or
    // chats, or impact) across nodes is doing one job, and being thrown back to
    // Details on every click would make them re-open the same tab every time.
    setDetail(null);
    setImpact(null);
    setError(null);
    setConflict(false);
    setEditingBody(false);
    setEditingTitle(false);
    setEditingMeta(false);
    setAddingChild(false);
    setAddingLinkTo(null);
    setGroupOpen({});
    setPreview(null);
    setLinkTarget('');
    void getPlanNode(repositoryId, nodeId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setTitleDraft(d.node.title);
        setBodyDraft(d.node.body ?? '');
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      cancelled = true;
    };
  }, [repositoryId, nodeId]);

  // `impact` doubles as the cache flag, so the fetched depth has to be part of
  // what "already loaded" means — otherwise the control renders and does
  // nothing, which is worse than not offering it.
  const impactDepthRef = useRef<number | null>(null);
  useEffect(() => {
    if (tab !== 'impact') return;
    if (impact && impactDepthRef.current === impactDepth) return;
    impactDepthRef.current = impactDepth;
    void getPlanImpact(repositoryId, nodeId, impactDepth)
      .then((next) => {
        setImpact(next);
        setOpenImpactDepths(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load impact'));
  }, [tab, impact, impactDepth, repositoryId, nodeId]);

  const impactGroups = groupImpactHops(impact?.hops ?? []);

  // Returns whether the write landed, so a caller holding an in-place editor
  // can keep the user's draft on failure instead of silently dropping it.
  async function write(fn: () => Promise<unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      await fn();
      await reload();
      onChanged();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      // A 409 is not a generic failure — someone else wrote this node while the
      // panel was open, and the user has to see that before deciding what to do.
      if (/modified by someone else/i.test(message)) setConflict(true);
      setError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!detail) {
    return (
      <aside className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        {error ? (
          <FormError message={error} />
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </aside>
    );
  }

  const node = detail.node;
  const rolled = isRolledUp(node.status, node.rolledStatus);

  // The inline title editor's commit path: Enter blurs the input, and the blur
  // itself is what applies — one path, no double-apply guard needed. A no-op
  // edit (empty or unchanged) just restores the title. On failure the editor
  // STAYS open so the draft survives the error/conflict banner.
  async function applyTitleRename(): Promise<void> {
    const next = titleDraft.trim();
    if (!next || next === node.title) {
      setTitleDraft(node.title);
      setEditingTitle(false);
      return;
    }
    const ok = await write(() =>
      updatePlanNode(repositoryId, nodeId, {
        expectedVersion: node.version,
        title: next,
      }),
    );
    if (ok) setEditingTitle(false);
  }

  // The badge row's OK button: both fields go in ONE patch (one version bump),
  // and a failed write keeps the editor open with the drafts intact.
  async function applyMeta(): Promise<void> {
    if (statusDraft === node.status && kindDraft === node.kind) {
      setEditingMeta(false);
      return;
    }
    const ok = await write(() =>
      updatePlanNode(repositoryId, nodeId, {
        expectedVersion: node.version,
        status: statusDraft,
        kind: kindDraft,
      }),
    );
    if (ok) setEditingMeta(false);
  }

  // Delete cannot ride write(): write() reloads THIS node after the mutation,
  // and the node no longer exists, so the 404 threw before onChanged() could
  // run and the grid kept rendering the deleted card until the user navigated.
  // Refresh the page first, then unmount.
  async function applyDelete(): Promise<void> {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      await deletePlanNode(repositoryId, nodeId);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setSaving(false);
    }
  }

  async function applyAddChild(): Promise<void> {
    const title = childTitle.trim();
    if (!title) return;
    const ok = await write(() => createPlanNode(repositoryId, { parentId: nodeId, title }));
    if (ok) {
      setChildTitle('');
      setAddingChild(false);
    }
  }

  return (
    <aside className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex items-start gap-2.5">
        {editingTitle ? null : (
          <button
            type="button"
            title="Rename this node"
            onClick={() => {
              setTitleDraft(node.title);
              setEditingTitle(true);
            }}
            className="mt-1 text-neutral-500 hover:text-neutral-200"
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              disabled={saving}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  // Cancel, not apply: restore the loaded title and close the
                  // editor. No blur() call — unmounting the input moves focus
                  // off it, and even a late blur would no-op on the restored
                  // draft.
                  setTitleDraft(node.title);
                  setEditingTitle(false);
                }
              }}
              onBlur={() => void applyTitleRename()}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-base font-semibold text-neutral-100 outline-none focus:border-indigo-500"
            />
          ) : (
            <h2 className="truncate text-base font-semibold text-neutral-100">{node.title}</h2>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-sm text-neutral-500">
          ✕
        </button>
      </div>

      {editingMeta ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-neutral-400">Status</span>
              <select
                value={statusDraft}
                disabled={saving}
                onChange={(e) => setStatusDraft(e.target.value as PlanNodeStatus)}
                className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
              >
                {PLAN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-neutral-400">Kind</span>
              <select
                value={kindDraft}
                disabled={saving}
                onChange={(e) => setKindDraft(e.target.value as PlanNodeDetail['node']['kind'])}
                className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
              >
                {(node.kind === 'decision'
                  ? (['decision', ...PLAN_KINDS] as const)
                  : PLAN_KINDS
                ).map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Button size="sm" disabled={saving} onClick={() => void applyMeta()}>
                OK
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => setEditingMeta(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={statusBadge(node.rolledStatus)}>{statusLabel(node.rolledStatus)}</Badge>
          {node.kind !== 'decision' && <Badge>{kindLabel(node.kind)}</Badge>}
          <button
            type="button"
            title="Change status or kind"
            onClick={() => {
              setStatusDraft(node.status);
              setKindDraft(node.kind);
              setEditingMeta(true);
            }}
            className="text-neutral-500 hover:text-neutral-200"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {rolled && (
        // A user who set this node to "done" and sees amber deserves to be told
        // which of its descendants is responsible, not left to guess.
        <p className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
          Shown as <strong>{statusLabel(node.rolledStatus)}</strong> because of what is below it.
          Its own status is {statusLabel(node.status)}.
        </p>
      )}

      {conflict && (
        <p className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
          Someone (or a plan chat) changed this node while you had it open. Your edit was NOT
          applied. Reload to see theirs, then re-apply yours.
        </p>
      )}

      <nav className="flex gap-1 border-b border-neutral-800 text-xs">
        {(['details', 'links', 'chat', 'impact'] as PlanPanelTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTabChange(t)}
            className={`flex items-center gap-1 px-2 py-1 capitalize ${
              tab === t ? 'border-b-2 border-indigo-400 text-neutral-100' : 'text-neutral-500'
            }`}
          >
            {t}
            {t === 'chat' && tab !== 'chat' && unreadCount > 0 && (
              <span className="rounded-full bg-indigo-500 px-1.5 text-[10px] font-medium text-white">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <FormError message={conflict ? null : error} />

      {tab === 'details' && (
        <div className="flex flex-col gap-3">
          {editingBody ? (
            <div className="flex flex-col gap-2">
              {/* key={nodeId}: a hard reset when a different node is opened —
                  the editor reads `value` at creation only. `breaks` mirrors
                  MarkdownView's line-break policy so plain-text bodies keep
                  their newlines. */}
              <MarkdownEditor
                key={nodeId}
                value={bodyDraft}
                onChange={setBodyDraft}
                placeholder="Describe this node…"
                breaks={!looksLikeMarkdown(node.body ?? '')}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    void write(async () => {
                      await updatePlanNode(repositoryId, nodeId, {
                        expectedVersion: node.version,
                        body: bodyDraft,
                      });
                      setEditingBody(false);
                    })
                  }
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setBodyDraft(node.body ?? '');
                    setEditingBody(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {node.body ? (
                <MarkdownView body={node.body} />
              ) : (
                <p className="text-xs text-neutral-600">No description yet.</p>
              )}
              <button
                type="button"
                onClick={() => setEditingBody(true)}
                className="self-start text-xs text-indigo-300 underline"
              >
                Edit description
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-neutral-800 pt-3">
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-500"
              disabled={saving}
              onClick={() => {
                setChildTitle('');
                setAddingChild((v) => !v);
              }}
            >
              Add a child
            </Button>
            {/* No `Create a task` for research/external nodes: a research node's
                whole flow IS the advisory task the Research button spawns, and
                external work lives outside the system — if it needs
                investigating first, that is what the `research` kind (or the
                chat tab) is for. */}
            {node.kind !== 'external' && node.kind !== 'research' && (
              <Link
                href={`/tasks/new?repositoryId=${repositoryId}&planNodeId=${nodeId}&title=${encodeURIComponent(node.title)}`}
              >
                <Button size="sm">Create a task from this</Button>
              </Link>
            )}
            {node.kind === 'research' && (
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  // Spawn, then go watch it — the advisory task's decision gate
                  // is where the user's input is needed, and staying on the
                  // panel made the click look like a no-op.
                  void (async () => {
                    let taskId: string | null = null;
                    const ok = await write(async () => {
                      ({ taskId } = await startPlanAdvisory(repositoryId, nodeId, {}));
                    });
                    if (ok && taskId) router.push(`/tasks/${taskId}`);
                  })();
                }}
              >
                Research it
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={saving}
              onClick={() => {
                const n = node.totalDescendants;
                const warning =
                  n > 0
                    ? `Delete "${node.title}" and everything under it (${n} node${n === 1 ? '' : 's'})?`
                    : `Delete "${node.title}"?`;
                if (!window.confirm(warning)) return;
                void applyDelete();
              }}
            >
              Delete
            </Button>
          </div>

          {addingChild && (
            <div className="flex gap-2">
              <input
                autoFocus
                value={childTitle}
                disabled={saving}
                onChange={(e) => setChildTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && childTitle.trim()) void applyAddChild();
                  // Escape cancels. The page-level ESC handler ignores INPUT
                  // targets, so this never also closes the panel.
                  if (e.key === 'Escape') {
                    setChildTitle('');
                    setAddingChild(false);
                  }
                }}
                placeholder="Name the new child"
                className="h-8 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-indigo-500"
              />
              <Button
                size="sm"
                disabled={saving || !childTitle.trim()}
                onClick={() => void applyAddChild()}
              >
                OK
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setChildTitle('');
                  setAddingChild(false);
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {detail.tasks.length > 0 && (
            <div className="border-t border-neutral-800 pt-3">
              <p className="mb-1 text-xs font-medium text-neutral-400">Tasks</p>
              {detail.tasks.map((t) => (
                <Link
                  key={t.taskId}
                  href={`/tasks/${t.taskId}`}
                  className="block truncate text-xs text-indigo-300 underline"
                >
                  {t.title} — {t.status}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'links' && (
        <div className="flex flex-col gap-3">
          {groupPlanEdges(detail.edges, nodeId).map((group) => {
            const folded = !(groupOpen[group.id] ?? group.items.length > 0);
            return (
              <div key={group.id} className="rounded-md border border-neutral-800">
                <button
                  type="button"
                  aria-expanded={!folded}
                  onClick={() => setGroupOpen((prev) => ({ ...prev, [group.id]: folded }))}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                >
                  {folded ? (
                    <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
                  )}
                  {/* White and bold rather than amber: amber already means
                        "blocked, needs a person" everywhere else in this UI. */}
                  <span className="text-xs font-semibold text-neutral-100">{group.label}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={`Add to ${group.label.toLowerCase()}`}
                    aria-label={`Add to ${group.label.toLowerCase()}`}
                    onClick={(e) => {
                      // Nested in the header button, so the fold must not
                      // also toggle when the + is what was hit.
                      e.stopPropagation();
                      setLinkTarget('');
                      setAddingLinkTo((cur) => (cur === group.id ? null : group.id));
                      // The row it opens lives in the body, so a folded group
                      // would swallow it.
                      setGroupOpen((prev) => ({ ...prev, [group.id]: true }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      setLinkTarget('');
                      setAddingLinkTo((cur) => (cur === group.id ? null : group.id));
                    }}
                    className="text-neutral-500 hover:text-neutral-200"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span className="ml-auto text-[11px] text-neutral-500">{group.items.length}</span>
                </button>
                {!folded && (
                  <div className="flex flex-col gap-1 border-t border-neutral-800 px-2 py-1.5">
                    {addingLinkTo === group.id && (
                      // First row, inside the group it adds to: the kind and
                      // the direction are the group's, so only the node is
                      // still a question — no kind dropdown needed.
                      <div className="flex items-center gap-2 pb-1">
                        <select
                          autoFocus
                          value={linkTarget}
                          disabled={saving}
                          onChange={(e) => setLinkTarget(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setLinkTarget('');
                              setAddingLinkTo(null);
                            }
                          }}
                          className="h-8 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
                        >
                          <option value="">Pick a node…</option>
                          {tree
                            .filter(
                              (n) => n.id !== nodeId && !group.items.some((i) => i.nodeId === n.id),
                            )
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.title}
                              </option>
                            ))}
                        </select>
                        <Button
                          size="sm"
                          disabled={saving || !linkTarget}
                          onClick={() =>
                            void write(async () => {
                              const [kind, dir] = group.id.split(':');
                              await createPlanEdge(repositoryId, {
                                // An inbound group means the OTHER node points
                                // here, so the edge is written that way round.
                                fromNodeId: dir === 'out' ? nodeId : linkTarget,
                                toNodeId: dir === 'out' ? linkTarget : nodeId,
                                kind: kind as PlanEdgeKind,
                              });
                              setLinkTarget('');
                              setAddingLinkTo(null);
                            })
                          }
                        >
                          OK
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={saving}
                          onClick={() => {
                            setLinkTarget('');
                            setAddingLinkTo(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                    {group.items.length === 0 && addingLinkTo !== group.id && (
                      <p className="text-xs italic text-neutral-400">No links of this kind yet.</p>
                    )}
                    {group.items.map((item) => (
                      <div
                        key={item.edgeId}
                        className="flex items-center gap-2 text-xs text-neutral-300"
                      >
                        {/* Goes to the node on the other end — the same move
                              an impact hop makes, and the reason the group
                              carries that node's id rather than only its name. */}
                        <button
                          type="button"
                          onClick={() => onNavigate(item.nodeId)}
                          className="flex-1 truncate text-left hover:text-neutral-100 hover:underline"
                        >
                          {item.title}
                          {item.note && <span className="text-neutral-500"> — {item.note}</span>}
                        </button>
                        <button
                          type="button"
                          className="shrink-0 text-neutral-500 underline hover:text-neutral-300"
                          disabled={saving}
                          onClick={() =>
                            void write(() => deletePlanEdge(repositoryId, item.edgeId))
                          }
                        >
                          remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {detail.codeLinks.length > 0 && (
            <div className="border-t border-neutral-800 pt-3">
              <p className="mb-1 text-xs font-medium text-neutral-400">Code</p>
              {detail.codeLinks.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  title="Open this file"
                  onClick={() =>
                    setPreview({
                      repoPath: l.repoPath,
                      symbol: l.symbol,
                      evidence: l.evidence ?? null,
                    })
                  }
                  className="block w-full truncate text-left font-mono text-[11px] text-neutral-400 hover:text-neutral-200 hover:underline"
                >
                  {l.repoPath}
                  {l.symbol ? `::${l.symbol}` : ''}
                  {l.stale && <span className="ml-1 text-amber-400">(stale)</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {preview && (
        <CodePreviewDialog
          repositoryId={repositoryId}
          repoPath={preview.repoPath}
          symbol={preview.symbol}
          evidence={preview.evidence}
          open
          onOpenChange={(o) => !o && setPreview(null)}
        />
      )}

      {tab === 'chat' && (
        <PlanChat
          repositoryId={repositoryId}
          nodeId={nodeId}
          onPatched={onChanged}
          onRead={onRead}
          unreadCount={unreadCount}
        />
      )}

      {tab === 'impact' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-neutral-500">Reach</span>
            {IMPACT_DEPTH_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setImpactDepth(d)}
                title={`Nodes within ${d} hop${d === 1 ? '' : 's'} of this one`}
                className={`h-5 w-6 rounded border text-[11px] ${
                  d === impactDepth
                    ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                    : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {d}
              </button>
            ))}
            <span className="text-[11px] text-neutral-600">hop{impactDepth === 1 ? '' : 's'}</span>
          </div>

          {!impact ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : (
            <>
              {/* Two different facts, deliberately not one banner.
               *
               * Hitting the DEPTH limit is the radius doing its job: the user
               * asked for N hops and there is more further out. At the default
               * of 1 that is true of nearly every linked node, so raising it as
               * an alarm would mark almost every result incomplete — which is
               * precisely what trains a reader to ignore the alarm. It gets a
               * quiet line and a way to go further.
               *
               * Hitting the NODE limit is a cap nobody asked for, and the only
               * one that can hide something the chosen radius should have
               * shown. That stays amber. Either way more is never silent: a
               * short list read as "nothing else is affected" is the failure
               * this view exists to prevent. */}
              {impact.truncated?.reason === 'nodes' && (
                <p className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
                  Showing {impact.hops.length} nodes — the walk stopped at its limit of{' '}
                  {impact.truncated.limit}, so more lie beyond even within {impactDepth} hop
                  {impactDepth === 1 ? '' : 's'}.
                </p>
              )}
              {impact.truncated?.reason === 'depth' && (
                <p className="text-[11px] text-neutral-500">
                  More lies beyond {impactDepth} hop{impactDepth === 1 ? '' : 's'}.
                  {impactDepth < IMPACT_DEPTH_CHOICES[IMPACT_DEPTH_CHOICES.length - 1]! && (
                    <button
                      type="button"
                      onClick={() => setImpactDepth(impactDepth + 1)}
                      className="ml-1 text-indigo-300 underline"
                    >
                      Reach {impactDepth + 1} hop{impactDepth + 1 === 1 ? '' : 's'}
                    </button>
                  )}
                </p>
              )}
              {impact.hops.length === 0 ? (
                <p className="text-xs text-neutral-600">
                  Nothing else is linked to this node
                  {impactDepth > 1 ? ` within ${impactDepth} hops` : ''} yet. Add links on the Links
                  tab.
                </p>
              ) : (
                <>
                  <PlanGraph source={impact.mermaid} onNodeClick={onNavigate} />
                  {impact.mermaidOmitted > 0 && (
                    <p className="text-[11px] text-neutral-500">
                      Diagram shows the {impact.hops.length - impact.mermaidOmitted} nearest;{' '}
                      {impact.mermaidOmitted} more are in the list below.
                    </p>
                  )}
                  {impactGroups.map((g) => {
                    const open = (openImpactDepths ?? defaultOpenImpactDepths(impactGroups)).has(
                      g.depth,
                    );
                    return (
                      <div key={g.depth} className="rounded border border-neutral-800">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenImpactDepths((prev) => {
                              const next = new Set(prev ?? defaultOpenImpactDepths(impactGroups));
                              if (next.has(g.depth)) next.delete(g.depth);
                              else next.add(g.depth);
                              return next;
                            })
                          }
                          className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-neutral-400 hover:text-neutral-200"
                        >
                          {open ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {g.label}
                          <span className="text-neutral-600">({g.hops.length})</span>
                        </button>
                        {open && (
                          <div className="flex flex-col gap-2 border-t border-neutral-800 px-2 py-1.5">
                            {/* Relation sub-groups, all open: the depth group
                                above is the thing that collapses, and a second
                                closed layer would hide every row behind two
                                clicks. Only relations that are actually present
                                are emitted, so none of these is ever empty. */}
                            {g.relations.map((r) => (
                              <div key={r.id} className="flex flex-col">
                                <p className="text-[10px] uppercase tracking-wide text-neutral-600">
                                  {r.label}{' '}
                                  <span className="text-neutral-700">({r.hops.length})</span>
                                </p>
                                {r.hops.map((h) => (
                                  <button
                                    key={h.nodeId}
                                    type="button"
                                    onClick={() => onNavigate(h.nodeId)}
                                    title={h.title ?? undefined}
                                    className="truncate pl-2 text-left text-xs text-neutral-300 hover:text-neutral-100"
                                  >
                                    {h.title}
                                  </button>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
