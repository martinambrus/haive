'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  defaultOpenImpactDepths,
  groupImpactHops,
  type PlanImpactHopLike,
} from './plan-impact-groups';

/**
 * A node's affected set, grouped by distance and then by relation.
 *
 * The grouping rationale lives with `groupImpactHops`; this is the render. Two
 * views draw it: the plan panel's Impact tab, where a row SELECTS the node in
 * the panel beside it, and gate 1's affected-components section, where a row is
 * a LINK — the gate carries an unsaved feedback textarea, so navigating away in
 * place would lose it. Hence the two node props: pass `hrefFor` for a link,
 * `onSelect` for an in-place selection.
 */
export function PlanImpactList({
  hops,
  onSelect,
  hrefFor,
}: {
  hops: PlanImpactHopLike[];
  onSelect?: (nodeId: string) => void;
  hrefFor?: (nodeId: string) => string;
}) {
  const groups = groupImpactHops(hops);
  // Null until the reader touches one, so a re-fetch at a new radius re-derives
  // the default rather than keeping a depth that may no longer exist.
  const [open, setOpen] = useState<Set<number> | null>(null);
  const isOpen = (depth: number): boolean => (open ?? defaultOpenImpactDepths(groups)).has(depth);

  return (
    <>
      {groups.map((g) => (
        <div key={g.depth} className="rounded border border-neutral-800">
          <button
            type="button"
            onClick={() =>
              setOpen((prev) => {
                const next = new Set(prev ?? defaultOpenImpactDepths(groups));
                if (next.has(g.depth)) next.delete(g.depth);
                else next.add(g.depth);
                return next;
              })
            }
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            {isOpen(g.depth) ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {g.label}
            {/* Same weight as the relation counts below it, so the two rows do
                not disagree about how loud a count is. */}
            <span className="text-neutral-400">({g.hops.length})</span>
          </button>
          {isOpen(g.depth) && (
            <div className="flex flex-col gap-2 border-t border-neutral-800 px-2 py-1.5">
              {/* Relation sub-groups, all open: the depth group above is the
                  thing that collapses, and a second closed layer would hide
                  every row behind two clicks. Only relations that are actually
                  present are emitted, so none of these is ever empty. */}
              {g.relations.map((r) => (
                <div key={r.id} className="flex flex-col">
                  {/* Indigo, matching the chat transcript's speaker label: the
                      neutral-600/700 pair this used is the same one that was
                      already found barely legible on this background, and these
                      headings are what the reader scans the list by. */}
                  <p className="text-[10px] uppercase tracking-wide text-indigo-300">
                    {r.label} <span className="text-neutral-400">({r.hops.length})</span>
                  </p>
                  {r.hops.map((h) =>
                    hrefFor ? (
                      <a
                        key={h.nodeId}
                        href={hrefFor(h.nodeId)}
                        target="_blank"
                        rel="noreferrer"
                        title={h.title ?? undefined}
                        className="truncate pl-2 text-left text-xs text-neutral-300 hover:text-neutral-100 hover:underline"
                      >
                        {h.title}
                      </a>
                    ) : (
                      <button
                        key={h.nodeId}
                        type="button"
                        onClick={() => onSelect?.(h.nodeId)}
                        title={h.title ?? undefined}
                        className="truncate pl-2 text-left text-xs text-neutral-300 hover:text-neutral-100"
                      >
                        {h.title}
                      </button>
                    ),
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
