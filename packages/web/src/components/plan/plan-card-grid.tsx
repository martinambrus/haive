'use client';

import type { PlanNode } from '@/lib/api-client';
import { Badge } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { countLabel, kindLabel, statusBadge, statusDot, statusLabel } from './plan-status';

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
}: {
  nodes: PlanNode[];
  selectedId: string | null;
  onSelect: (node: PlanNode) => void;
  onDescend: (node: PlanNode) => void;
  emptyMessage: string;
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
            role="button"
            tabIndex={0}
            onClick={() => onSelect(node)}
            onDoubleClick={() => node.directChildren > 0 && onDescend(node)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(node);
              if (e.key === 'ArrowRight' && node.directChildren > 0) onDescend(node);
            }}
            className={`flex cursor-pointer flex-col gap-2 rounded-md border bg-neutral-950 px-4 py-3 text-left transition-colors ${
              selected
                ? 'border-indigo-500 ring-1 ring-indigo-500/40'
                : 'border-neutral-800 hover:border-neutral-700'
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot(node.rolledStatus)}`}
                title={statusLabel(node.rolledStatus)}
              />
              <span className="flex-1 text-sm font-medium text-neutral-100">{node.title}</span>
            </div>

            {node.body && (
              <div className="line-clamp-2 text-xs text-neutral-500">
                <InlineMarkdown body={node.body} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={statusBadge(node.rolledStatus)}>
                {statusLabel(node.rolledStatus)}
              </Badge>
              {node.kind !== 'component' && node.kind !== 'decision' && (
                <Badge>{kindLabel(node.kind)}</Badge>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-neutral-600">
              {/* Both numbers, never just the total: "3" hides that those three
                  children carry 412 descendants, which is the one thing a
                  drill-down has to convey. */}
              <span title="direct children / all descendants">
                {countLabel(node.directChildren, node.totalDescendants)}
              </span>
              {node.directChildren > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDescend(node);
                  }}
                  className="text-indigo-300 underline"
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
