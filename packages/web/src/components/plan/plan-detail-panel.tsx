'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil } from 'lucide-react';
import {
  createPlanEdge,
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
import { MarkdownEditor } from '@/components/markdown/markdown-editor';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { looksLikeMarkdown } from '@/components/markdown/looks-like-markdown';
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

type Tab = 'details' | 'links' | 'chat' | 'impact';

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
  onChanged,
  onNavigate,
  onClose,
}: {
  repositoryId: string;
  nodeId: string;
  tree: PlanTreeNode[];
  onChanged: () => void;
  onNavigate: (nodeId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<PlanNodeDetail | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [impact, setImpact] = useState<PlanImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [statusDraft, setStatusDraft] = useState<PlanNodeStatus>('todo');
  const [kindDraft, setKindDraft] = useState<PlanNodeDetail['node']['kind']>('component');
  const [bodyDraft, setBodyDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkKind, setLinkKind] = useState<PlanEdgeKind>('depends_on');

  const reload = async (): Promise<void> => {
    const d = await getPlanNode(repositoryId, nodeId);
    setDetail(d);
    setTitleDraft(d.node.title);
    setBodyDraft(d.node.body ?? '');
  };

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setImpact(null);
    setError(null);
    setConflict(false);
    setEditingBody(false);
    setEditingTitle(false);
    setEditingMeta(false);
    setTab('details');
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

  useEffect(() => {
    if (tab !== 'impact' || impact) return;
    void getPlanImpact(repositoryId, nodeId)
      .then(setImpact)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load impact'));
  }, [tab, impact, repositoryId, nodeId]);

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
        {(['details', 'links', 'chat', 'impact'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-2 py-1 capitalize ${
              tab === t ? 'border-b-2 border-indigo-400 text-neutral-100' : 'text-neutral-500'
            }`}
          >
            {t}
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
                void write(async () => {
                  await deletePlanNode(repositoryId, nodeId);
                  onClose();
                });
              }}
            >
              Delete
            </Button>
          </div>

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
          {detail.edges.length === 0 ? (
            <p className="text-xs text-neutral-600">No links yet.</p>
          ) : (
            detail.edges.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-xs text-neutral-300">
                <span className="flex-1 truncate">
                  {e.fromTitle}{' '}
                  <span className="text-neutral-600">{e.kind.replace(/_/g, ' ')}</span> {e.toTitle}
                </span>
                <button
                  type="button"
                  className="text-neutral-500 underline"
                  disabled={saving}
                  onClick={() => void write(() => deletePlanEdge(repositoryId, e.id))}
                >
                  remove
                </button>
              </div>
            ))
          )}

          <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
            <select
              value={linkKind}
              onChange={(e) => setLinkKind(e.target.value as PlanEdgeKind)}
              className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
            >
              <option value="depends_on">this depends on…</option>
              <option value="affects">this affects…</option>
              <option value="implements">this implements…</option>
            </select>
            <select
              value={linkTarget}
              onChange={(e) => setLinkTarget(e.target.value)}
              className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
            >
              <option value="">Pick a node…</option>
              {tree
                .filter((n) => n.id !== nodeId)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || !linkTarget}
              onClick={() =>
                void write(async () => {
                  await createPlanEdge(repositoryId, {
                    fromNodeId: nodeId,
                    toNodeId: linkTarget,
                    kind: linkKind,
                  });
                  setLinkTarget('');
                })
              }
            >
              Add link
            </Button>
          </div>

          {detail.codeLinks.length > 0 && (
            <div className="border-t border-neutral-800 pt-3">
              <p className="mb-1 text-xs font-medium text-neutral-400">Code</p>
              {detail.codeLinks.map((l) => (
                <p key={l.id} className="truncate font-mono text-[11px] text-neutral-400">
                  {l.repoPath}
                  {l.symbol ? `::${l.symbol}` : ''}
                  {l.stale && <span className="ml-1 text-amber-400">(stale)</span>}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <PlanChat repositoryId={repositoryId} nodeId={nodeId} onPatched={onChanged} />
      )}

      {tab === 'impact' && (
        <div className="flex flex-col gap-2">
          {!impact ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : (
            <>
              {impact.truncated && (
                // Shown, never swallowed: a short list read as "nothing else is
                // affected" is the failure this view exists to prevent.
                <p className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
                  Stopped at the {impact.truncated.reason} limit of {impact.truncated.limit}. There
                  are more affected nodes than are shown here.
                </p>
              )}
              {impact.hops.length === 0 ? (
                <p className="text-xs text-neutral-600">
                  Nothing else is linked to this node yet. Add links on the Links tab.
                </p>
              ) : (
                <>
                  <PlanGraph source={impact.mermaid} onNodeClick={onNavigate} />
                  {impact.hops.map((h) => (
                    <button
                      key={h.nodeId}
                      type="button"
                      onClick={() => onNavigate(h.nodeId)}
                      className="truncate text-left text-xs text-neutral-300 hover:text-neutral-100"
                    >
                      <span className="text-neutral-600">{'· '.repeat(h.depth)}</span>
                      {h.title}{' '}
                      <span className="text-neutral-600">({h.viaKind.replace(/_/g, ' ')})</span>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
