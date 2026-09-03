'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanTreeNode } from '@/lib/api-client';
import { BLOCKED_GLYPH, sequenceChip, sequenceLabel, statusDot, statusLabel } from './plan-status';
import { ancestorsOf, computeVisibleSet, flattenVisible } from './plan-tree-filter';

/**
 * Hierarchy only — no edges.
 *
 * Deliberate: the tree answers "where am I and what is under me", and drawing
 * cross-links into it would turn a scannable outline into a graph nobody can
 * follow. The links live on the detail panel and the impact graph, where they
 * are the subject rather than the noise.
 *
 * Arrow keys select as they move, so the panel follows the cursor without a
 * second keystroke. Selecting fetches the node and re-points the whole panel,
 * so the select is DEBOUNCED: a held arrow key repeats every ~30ms and would
 * otherwise fire a request per row it passed over. Enter/Space commits
 * immediately for anyone who would rather not wait.
 */
export function PlanTree({
  nodes,
  selectedId,
  onSelect,
  matchIds,
  unread,
}: {
  nodes: PlanTreeNode[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  /** Unread chat replies per node id. Never rolled up: a badge on a parent
   *  makes the user search a subtree for the node that actually has one. */
  unread?: Record<string, number>;
  /** Server-search matches. While set, the tree shows only these nodes plus
   *  the ancestors needed to keep the hierarchy readable. */
  matchIds?: ReadonlySet<string> | null;
}) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Everything starts expanded down to the first two levels; deeper branches
  // collapse so a 400-node plan does not open as a wall of text.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const deep = new Set<string>();
    const kids = new Map<string | null, PlanTreeNode[]>();
    for (const n of nodes) {
      const run = kids.get(n.parentId);
      if (run) run.push(n);
      else kids.set(n.parentId, [n]);
    }
    const walk = (id: string, depth: number): void => {
      for (const child of kids.get(id) ?? []) {
        if (depth >= 1 && (kids.get(child.id)?.length ?? 0) > 0) deep.add(child.id);
        walk(child.id, depth + 1);
      }
    };
    for (const root of kids.get(null) ?? []) walk(root.id, 0);
    return deep;
  });

  const expand = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    [],
  );
  const fold = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      }),
    [],
  );
  const toggle = (id: string): void => (collapsed.has(id) ? expand(id) : fold(id));

  // Every match plus its ancestors. Extracted so the walk (cycle guard,
  // empty-set-is-still-a-filter) is unit-testable without a DOM.
  const keep = useMemo(() => computeVisibleSet(nodes, matchIds), [matchIds, nodes]);
  const rows = useMemo(() => flattenVisible(nodes, collapsed, keep), [nodes, collapsed, keep]);

  // Reveal whatever is selected, however it got selected — a link row, an
  // impact hop, a breadcrumb. A selected row inside a folded branch is
  // selected invisibly, which reads as the click having done nothing.
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ancestorsOf(nodes, selectedId)) {
        if (next.delete(id)) changed = true;
      }
      // Same set back when nothing was folded: a new Set every time would
      // re-render the whole tree on every selection.
      return changed ? next : prev;
    });
  }, [selectedId, nodes]);

  const selectedRef = useRef<HTMLDivElement | null>(null);
  // After the expansion above has rendered — hence `collapsed` in the deps.
  // `nearest` scrolls the tree's own overflow container and leaves the page
  // where it is.
  useEffect(() => {
    if (!selectedId) return;
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, collapsed, keep]);

  // The keyboard cursor. Follows the selection when it changes from elsewhere,
  // so tabbing into the tree resumes where the user actually is.
  const [cursorId, setCursorId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId) setCursorId(selectedId);
  }, [selectedId]);
  const cursor = cursorId && rows.some((r) => r.id === cursorId) ? cursorId : (rows[0]?.id ?? null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (selectTimer.current) clearTimeout(selectTimer.current);
    },
    [],
  );

  /** Select what the cursor landed on, once it stops moving. Skipped when it is
   *  already the selection: onSelect TOGGLES, so re-sending it would close the
   *  panel the arrow key was meant to fill. */
  const selectSoon = (id: string): void => {
    if (selectTimer.current) clearTimeout(selectTimer.current);
    selectTimer.current = setTimeout(() => {
      if (id !== selectedId) onSelect(id);
    }, 180);
  };

  const focusRow = (id: string): void => {
    setCursorId(id);
    selectSoon(id);
    // Focus rather than scrollIntoView: it moves the cursor AND reveals the row
    // in one step, and keeps the browser's own focus ring where the user is.
    hostRef.current
      ?.querySelector<HTMLButtonElement>(`[data-row-id="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: false });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!cursor) return;
    const i = rows.findIndex((r) => r.id === cursor);
    if (i < 0) return;
    const row = rows[i]!;
    const move = (to: number): void => {
      const next = rows[to];
      if (next) focusRow(next.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(i - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        // Open what is closed, then step into it — the two halves of "go
        // deeper", in the order a tree widget is expected to do them.
        if (row.hasChildren && collapsed.has(row.id) && !keep) expand(row.id);
        else if (row.hasChildren) move(i + 1);
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (row.hasChildren && !collapsed.has(row.id) && !keep) {
          fold(row.id);
          break;
        }
        // Already closed (or a leaf): the way out is up to the parent.
        const parent = row.parentId;
        if (parent) focusRow(parent);
        break;
      }
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (selectTimer.current) clearTimeout(selectTimer.current);
        onSelect(cursor);
        break;
      default:
        break;
    }
  };

  if (rows.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-neutral-500">
        {keep ? 'Nothing matched.' : 'No plan yet.'}
      </p>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
    <div ref={hostRef} role="tree" onKeyDown={onKeyDown} className="flex flex-col">
      {rows.map((row) => {
        const node = byId.get(row.id);
        if (!node) return null;
        const isCollapsed = keep ? false : collapsed.has(row.id);
        const isMatch = matchIds?.has(row.id) ?? false;
        const isSelected = row.id === selectedId;
        return (
          <div
            key={row.id}
            ref={isSelected ? selectedRef : undefined}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isSelected}
            aria-expanded={row.hasChildren ? !isCollapsed : undefined}
            // `group` + no vertical padding of its own: the padding moves onto
            // the title button so its hit area IS the row. It used to leave a
            // 4px band at the top and bottom of every row that highlighted
            // nothing and clicked nothing, while looking like part of the node.
            className={`group flex items-center gap-1.5 rounded pl-1.5 pr-5 text-sm ${
              isSelected ? 'bg-indigo-500/15 text-neutral-100' : 'text-neutral-300'
            }`}
            style={{ paddingLeft: `${row.depth * 14 + 6}px` }}
          >
            {row.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => toggle(row.id)}
                className="w-4 shrink-0 py-1 text-neutral-500"
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
            ) : (
              <span className="w-4 shrink-0 py-1" />
            )}
            {/* The number sits OUTSIDE the title button, which is `flex-1
                truncate` — inside it, a long title would truncate the number
                away exactly on the deep rows where it is hardest to find. */}
            <span
              className={`shrink-0 rounded border px-1 font-mono text-[10px] tabular-nums ${sequenceChip(node.blockedCount)}`}
              title={
                node.blockedCount > 0
                  ? `${sequenceLabel(node.sequence)} in build order — waiting on ${node.blockedCount} thing${node.blockedCount === 1 ? '' : 's'}`
                  : `${sequenceLabel(node.sequence)} in build order — ready to start`
              }
            >
              {node.blockedCount > 0 ? `${BLOCKED_GLYPH} ` : ''}
              {node.sequence}
            </span>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(node.rolledStatus)}`}
              title={statusLabel(node.rolledStatus)}
            />
            <button
              type="button"
              data-row-id={row.id}
              // Roving tabindex: one stop for the whole tree, so Tab reaches it
              // once and the arrows take over from there.
              tabIndex={row.id === cursor ? 0 : -1}
              onFocus={() => setCursorId(row.id)}
              onClick={() => onSelect(row.id)}
              className={`flex-1 truncate py-1 text-left group-hover:text-neutral-100 ${
                isMatch ? 'font-medium text-neutral-100' : ''
              }`}
            >
              {node.title}
            </button>
            {(unread?.[row.id] ?? 0) > 0 && (
              <span
                title={`${unread?.[row.id]} unread chat repl${unread?.[row.id] === 1 ? 'y' : 'ies'}`}
                className="shrink-0 rounded-full bg-indigo-500 px-1.5 text-[10px] font-medium text-white"
              >
                {unread?.[row.id]}
              </span>
            )}
            {node.totalDescendants > 0 && (
              <span className="shrink-0 text-[11px] text-neutral-600">{node.totalDescendants}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
