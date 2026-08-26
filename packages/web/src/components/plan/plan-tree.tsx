'use client';

import { useMemo, useState } from 'react';
import type { PlanTreeNode } from '@/lib/api-client';
import { statusDot, statusLabel } from './plan-status';

/**
 * Hierarchy only — no edges.
 *
 * Deliberate: the tree answers "where am I and what is under me", and drawing
 * cross-links into it would turn a scannable outline into a graph nobody can
 * follow. The links live on the detail panel and the impact graph, where they
 * are the subject rather than the noise.
 */
export function PlanTree({
  nodes,
  selectedId,
  onSelect,
  matchIds,
}: {
  nodes: PlanTreeNode[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  /** Server-search matches. While set, the tree shows only these nodes plus
   *  the ancestors needed to keep the hierarchy readable. */
  matchIds?: ReadonlySet<string> | null;
}) {
  const byParent = useMemo(() => {
    const m = new Map<string | null, PlanTreeNode[]>();
    for (const n of nodes) {
      const run = m.get(n.parentId);
      if (run) run.push(n);
      else m.set(n.parentId, [n]);
    }
    return m;
  }, [nodes]);

  // Everything starts expanded down to the first two levels; deeper branches
  // collapse so a 400-node plan does not open as a wall of text.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const deep = new Set<string>();
    const walk = (id: string, depth: number): void => {
      for (const child of byParent.get(id) ?? []) {
        if (depth >= 1 && (byParent.get(child.id)?.length ?? 0) > 0) deep.add(child.id);
        walk(child.id, depth + 1);
      }
    };
    for (const root of byParent.get(null) ?? []) walk(root.id, 0);
    return deep;
  });

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The filtered visibility set: every match plus each match's ancestors. An
  // ancestor carries no hit of its own, but without it a match would render as
  // a detached root and the outline would stop answering "where is this".
  // `has(cur)` doubles as the walk's cycle guard — every match walks its own
  // full chain, so stopping on an already-kept node loses nothing.
  const keep = useMemo(() => {
    // An EMPTY set stays a filter: zero hits must render "Nothing matched."
    // here exactly as the tiles view does, not silently unfilter the tree.
    if (!matchIds) return null;
    const parentOf = new Map<string, string | null>();
    for (const n of nodes) parentOf.set(n.id, n.parentId);
    const set = new Set<string>(matchIds);
    for (const id of matchIds) {
      let cur = parentOf.get(id) ?? null;
      while (cur && !set.has(cur)) {
        set.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }
    return set;
  }, [matchIds, nodes]);

  const render = (node: PlanTreeNode, depth: number): React.ReactNode => {
    const children = (byParent.get(node.id) ?? []).filter((c) => !keep || keep.has(c.id));
    // Filtering forces every kept branch open — a collapsed ancestor would
    // hide the very matches the filter exists to show.
    const isCollapsed = keep ? false : collapsed.has(node.id);
    const isMatch = matchIds?.has(node.id) ?? false;
    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-1.5 rounded py-1 pl-1.5 pr-5 text-sm ${
            node.id === selectedId ? 'bg-indigo-500/15 text-neutral-100' : 'text-neutral-300'
          }`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(node.id)}
              className="w-4 shrink-0 text-neutral-500"
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(node.rolledStatus)}`}
            title={statusLabel(node.rolledStatus)}
          />
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            className={`flex-1 truncate text-left hover:text-neutral-100 ${
              isMatch ? 'font-medium text-neutral-100' : ''
            }`}
          >
            {node.title}
          </button>
          {node.totalDescendants > 0 && (
            <span className="shrink-0 text-[11px] text-neutral-600">{node.totalDescendants}</span>
          )}
        </div>
        {!isCollapsed && children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  const roots = (byParent.get(null) ?? []).filter((r) => !keep || keep.has(r.id));
  if (roots.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-neutral-500">
        {keep ? 'Nothing matched.' : 'No plan yet.'}
      </p>
    );
  }
  return <div className="flex flex-col">{roots.map((r) => render(r, 0))}</div>;
}
