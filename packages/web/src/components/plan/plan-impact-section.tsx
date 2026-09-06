'use client';

import type { PlanImpactSection as PlanImpactSectionData } from '@haive/shared';
import { PlanGraph } from './plan-graph';
import { PlanImpactList } from './plan-impact-list';

/**
 * Gate 1's blast radius, drawn the way the plan canvas's own Impact tab draws
 * one.
 *
 * The step used to hand the form renderer a markdown list. MEASURED on a real
 * task: 363 bullets in a scroller holding 10,459px, with distance — the one
 * thing an impact answer is ABOUT — reduced to a `(2 hops)` suffix, nothing
 * clickable, and a diagram that drew 19 of those 363 while reporting 0 omitted.
 *
 * Every cap the data carries is stated. A short list read as "nothing else is
 * affected" is the failure this view exists to prevent, and this is the moment
 * the approver commits to the change.
 */
export function PlanImpactSection({ data }: { data: PlanImpactSectionData }) {
  const href = (nodeId: string): string =>
    `/repos/${encodeURIComponent(data.repositoryId)}/plan?node=${encodeURIComponent(nodeId)}`;
  const namedGroups = groupNamedByParent(data.named);
  const deeperThanDiagram = data.hops.some((h) => h.depth > data.mermaidDepth);
  const distances = countByDepth(data.hops);

  return (
    <div className="flex flex-col gap-3 px-3 py-2">
      {/* Two different facts, deliberately not one banner — the same split the
       *  Impact tab makes. Hitting the NODE limit is a cap nobody asked for and
       *  the only one that can hide something inside the radius that was walked,
       *  so it stays amber; hitting the DEPTH limit is the radius doing its job
       *  and gets a quiet line. Either way more is never silent. */}
      {data.truncated?.reason === 'nodes' && (
        <p className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
          Showing {data.hops.length} reached components — the walk stopped at its limit of{' '}
          {data.truncated.limit}, so more are affected than are listed here.
        </p>
      )}
      {data.truncated?.reason === 'depth' && (
        <p className="text-[11px] text-neutral-500">
          More lies beyond {data.truncated.limit} hop{data.truncated.limit === 1 ? '' : 's'} of the
          named components.
        </p>
      )}

      {data.diagramSkipped ? (
        <p className="text-[11px] text-neutral-500">
          No diagram: the spec named {data.named.length} components, and past{' '}
          {data.diagramSkipped.limit} starting points the picture is a wall of boxes rather than a
          graph. The lists below carry all of them.
        </p>
      ) : (
        data.mermaid.trim().length > 0 && (
          <>
            <PlanGraph
              source={data.mermaid}
              onNodeClick={(nodeId) => window.open(href(nodeId), '_blank', 'noopener')}
            />
            {deeperThanDiagram && (
              <p className="text-[11px] text-neutral-500">
                The diagram reaches {data.mermaidDepth} hop
                {data.mermaidDepth === 1 ? '' : 's'} out of the named components — further out is
                essentially the whole plan. The full reach is in the list below.
              </p>
            )}
            {data.mermaidOmitted > 0 && (
              /* Stated ALONE, never subtracted from the reached count: the
                 diagram walks a shorter radius than the list, so no arithmetic
                 between the two would be true. */
              <p className="text-[11px] text-neutral-500">
                {data.mermaidOmitted} further component{data.mermaidOmitted === 1 ? '' : 's'} the
                diagram reaches are listed below rather than drawn.
              </p>
            )}
          </>
        )
      )}

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-300">
          Named by the spec <span className="text-neutral-500">({data.named.length})</span>
        </p>
        <div className="flex max-h-56 flex-col gap-2 overflow-auto rounded border border-neutral-800 px-2 py-1.5">
          {namedGroups.map((g) => (
            <div key={g.key} className="flex flex-col">
              {/* The plan parent, so the list reads like the tree the components
                  live in rather than 161 sibling-less rows. */}
              <p className="truncate text-[10px] uppercase tracking-wide text-indigo-300">
                {g.parentTitle ?? 'Top level'}{' '}
                <span className="text-neutral-400">({g.items.length})</span>
              </p>
              {g.items.map((n) => (
                <a
                  key={n.id}
                  href={href(n.id)}
                  target="_blank"
                  rel="noreferrer"
                  title={n.title}
                  className="truncate pl-2 text-left text-xs text-neutral-300 hover:text-neutral-100 hover:underline"
                >
                  {n.title}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-300">
          Reached through the plan links{' '}
          <span className="text-neutral-500">({data.hops.length})</span>
        </p>
        {/* The distance breakdown up front, because the list below is a bounded
            scroller: with the nearest group open and 72 rows in it, the headings
            for the groups further out sit below the fold and nothing else says
            they exist. */}
        {distances.length > 1 && (
          <p className="text-[11px] text-neutral-500">
            {distances
              .map((d) => `${d.count} at ${d.depth} hop${d.depth === 1 ? '' : 's'}`)
              .join(' · ')}
          </p>
        )}
        {data.hops.length === 0 ? (
          <p className="text-xs text-neutral-600">
            The plan records no links out of the components the spec named.
          </p>
        ) : (
          <div className="flex max-h-96 flex-col gap-1 overflow-auto">
            <PlanImpactList hops={data.hops} hrefFor={href} />
          </div>
        )}
      </div>
    </div>
  );
}

interface NamedGroup {
  key: string;
  parentTitle: string | null;
  items: PlanImpactSectionData['named'];
}

/** Group the named components under their plan parent.
 *
 *  Order is the order the SPEC cited them, for the groups and inside each one.
 *  Unlike a walk's output — which `groupImpactHops` sorts by name precisely
 *  because the order it happened to reach things says nothing — this order is
 *  the document's own, and re-sorting it would throw away the only narrative the
 *  set has. */
function groupNamedByParent(named: PlanImpactSectionData['named']): NamedGroup[] {
  const groups: NamedGroup[] = [];
  const byKey = new Map<string, NamedGroup>();
  for (const n of named) {
    // Keyed on the title because that is all the payload carries; two distinct
    // parents that read identically merge into one heading, which is the same
    // thing the reader sees in the tree anyway.
    const key = n.parentTitle ?? '';
    let group = byKey.get(key);
    if (!group) {
      group = { key, parentTitle: n.parentTitle, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(n);
  }
  return groups;
}

/** How many components sit at each distance, nearest first. */
function countByDepth(hops: PlanImpactSectionData['hops']): { depth: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const h of hops) counts.set(h.depth, (counts.get(h.depth) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, count]) => ({ depth, count }));
}
