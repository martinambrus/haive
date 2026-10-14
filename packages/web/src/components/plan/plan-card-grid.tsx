'use client';

import type { PlanNode } from '@/lib/api-client';
import { Badge } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { humanPlanAction } from '@haive/shared/plan-resolution';
import {
  BLOCKED_GLYPH,
  DRIFT_GLYPH,
  blockedLabel,
  driftLabel,
  countLabel,
  kindLabel,
  sequenceChip,
  sequenceLabel,
  statusBadge,
  statusDot,
  statusLabel,
} from './plan-status';

/**
 * One level of the plan as a grid of cards.
 *
 * A grid, not a canvas engine: the interaction the plan describes is
 * NAVIGATION — pick a component, go into it, come back — not free-form layout,
 * and a graph library would buy a dependency plus a layout problem to solve
 * neither of which that interaction needs.
 *
 * Clicking selects (the detail panel follows); the enter affordance descends.
 * Two distinct actions on one card, so descending is never an accident when
 * someone meant to read.
 */
export function PlanCardGrid({
  nodes,
  selectedId,
  onSelect,
  onDescend,
  emptyMessage,
  unread,
  picked,
  onPick,
}: {
  nodes: PlanNode[];
  selectedId: string | null;
  /** Unread chat replies per node id — the same map the tree badges from. */
  unread?: Record<string, number>;
  onSelect: (node: PlanNode) => void;
  onDescend: (node: PlanNode) => void;
  emptyMessage: string;
  /** Nodes ticked for a single task spanning several of them. Separate from
   *  `selectedId`, which is "what the detail panel is showing" — one is a
   *  cursor, the other is a set, and conflating them would make reading a card
   *  add it to the task. */
  picked?: ReadonlySet<string>;
  /** Omitted entirely on a grid that does not offer picking, which is what
   *  keeps the checkbox off every other use of this component. */
  onPick?: (node: PlanNode, next: boolean) => void;
}) {
  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {nodes.map((node) => {
        const selected = node.id === selectedId;
        return (
          <div
            key={node.id}
            className={`relative flex flex-col gap-2 rounded-md border bg-neutral-950 px-4 py-3 text-left transition-colors ${
              selected
                ? 'border-indigo-500 ring-1 ring-indigo-500/40'
                : 'border-neutral-800 hover:border-neutral-700'
            }`}
          >
            <div className="flex items-start gap-2">
              {/* Its ::after covers the card; the tick, Open and body links sit above it. */}
              <button
                type="button"
                onClick={() => onSelect(node)}
                onDoubleClick={() => node.directChildren > 0 && onDescend(node)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' && node.directChildren > 0) onDescend(node);
                }}
                className="order-1 flex flex-1 cursor-pointer items-start gap-2 text-left after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-indigo-400"
              >
                <span
                  className={`relative z-10 shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] tabular-nums ${sequenceChip(node.blockedBy.length)}`}
                  title={`${sequenceLabel(node.sequence)} in build order`}
                >
                  {node.sequence}
                </span>
                <span
                  className={`relative z-10 mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot(node.rolledStatus)}`}
                  title={statusLabel(node.rolledStatus)}
                />
                <span className="flex-1 text-sm font-medium text-neutral-100">{node.title}</span>
              </button>
              {onPick && !humanPlanAction(node) && (
                // Not in the select button, or each tick would also select and scroll the panel.
                <input
                  type="checkbox"
                  checked={picked?.has(node.id) ?? false}
                  aria-label={`Include "${node.title}" in one task`}
                  title="Include in one task"
                  onChange={(e) => onPick(node, e.target.checked)}
                  className="relative z-10 mt-1 h-3.5 w-3.5 shrink-0 accent-indigo-500"
                />
              )}
            </div>

            {/* Named, not just counted: "waiting on 2 things" tells you to stop,
                the numbers tell you where to go instead. */}
            {node.blockedBy.length > 0 && (
              <p className="text-[11px] text-neutral-500">
                {BLOCKED_GLYPH} {blockedLabel(node.blockedBy)}
              </p>
            )}

            {node.driftedTasks > 0 && (
              <p className="text-[11px] text-amber-500/90">
                {DRIFT_GLYPH} {driftLabel(node.driftedTasks)}
              </p>
            )}

            {node.body && (
              <div className="line-clamp-2 text-xs text-neutral-500 [&_a]:relative [&_a]:z-10">
                <InlineMarkdown body={node.body} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={statusBadge(node.rolledStatus)}>
                {statusLabel(node.rolledStatus)}
              </Badge>
              {node.kind !== 'component' && <Badge>{kindLabel(node.kind)}</Badge>}
              {humanPlanAction(node) &&
                node.status !== 'done' &&
                node.status !== 'not_applicable' && (
                  <Badge>
                    {node.kind === 'decision'
                      ? 'Needs your decision'
                      : 'Needs action outside Haive'}
                  </Badge>
                )}
              {(unread?.[node.id] ?? 0) > 0 && (
                <span
                  title={`${unread?.[node.id]} unread chat repl${unread?.[node.id] === 1 ? 'y' : 'ies'}`}
                  className="relative z-10 rounded-full bg-indigo-500 px-1.5 text-[10px] font-medium text-white"
                >
                  {unread?.[node.id]}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-neutral-600">
              {/* Both numbers, never just the total: "3" hides that those three
                  children carry 412 descendants, which is the one thing a
                  drill-down has to convey. */}
              <span title="direct children / all descendants" className="relative z-10">
                {countLabel(node.directChildren, node.totalDescendants)}
              </span>
              {node.directChildren > 0 && (
                <button
                  type="button"
                  onClick={() => onDescend(node)}
                  className="relative z-10 text-indigo-300 underline"
                >
                  Open →
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
