'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
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
  const namedOmitted = data.namedOmitted ?? 0;
  const [namedOpen, setNamedOpen] = useState(true);
  // The nearest radius, matching the plan panel's own default: one hop is what
  // "if I change this, what else must change?" means, and MEASURED on a real
  // plan two hops reach a median of 130 nodes — an answer to nothing.
  const radii = data.diagrams.map((d) => d.depth);
  const [reach, setReach] = useState(radii[0] ?? 1);
  const diagram = data.diagrams.find((d) => d.depth === reach) ?? data.diagrams[0] ?? null;
  // Cumulative, because a diagram is: a two-hop picture contains the one-hop
  // one, and a list that did not would disagree with the image above it.
  const shownHops = data.hops.filter((h) => h.depth <= reach);
  const distances = countByDepth(data.hops);

  return (
    <div className="flex flex-col gap-3 px-3 py-2">
      {/* The reach control, then the picture. Both come first: the picture is the
          only part that shows the SHAPE of what the spec touches, and everything
          under it is a way to read the same set one row at a time.

          Only the radii the walk actually reached are offered. The plan panel's
          fixed 1-4 can afford a button that returns nothing because it
          re-fetches; over a frozen snapshot such a button would just do nothing. */}
      {radii.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-neutral-500">Reach</span>
          {radii.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setReach(d)}
              title={`Components within ${d} hop${d === 1 ? '' : 's'} of the ones the spec named`}
              className={`h-5 w-6 rounded border text-[11px] ${
                d === reach
                  ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                  : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {d}
            </button>
          ))}
          <span className="text-[11px] text-neutral-600">hop{reach === 1 ? '' : 's'}</span>
        </div>
      )}
      {diagram && diagram.mermaid.trim().length > 0 && (
        <>
          <PlanGraph
            key={diagram.depth}
            source={diagram.mermaid}
            onNodeClick={(nodeId) => window.open(href(nodeId), '_blank', 'noopener')}
          />
          {/* Each omission is its own sentence, and none of them is arithmetic
              on another: the diagram walks a shorter radius than the list, so
              subtracting one count from the other would state something untrue. */}
          {namedOmitted > 0 && (
            <p className="text-[11px] text-neutral-500">
              Drawn from the {data.named.length - namedOmitted} components the spec names first;{' '}
              {namedOmitted} more are in the list below.
            </p>
          )}
          {diagram.omitted > 0 && (
            <p className="text-[11px] text-neutral-500">
              {diagram.omitted} further component{diagram.omitted === 1 ? '' : 's'} within {reach}{' '}
              hop{reach === 1 ? '' : 's'} are listed below rather than drawn — the picture is full.
            </p>
          )}
        </>
      )}

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

      <div className="flex flex-col gap-1">
        {/* Collapsible for the same reason the depth groups are: on a wide spec
            this block is 161 rows, and it sits between the diagram and the
            reached set. */}
        <button
          type="button"
          onClick={() => setNamedOpen((v) => !v)}
          className="flex items-center gap-1 text-left text-xs font-medium text-neutral-300 hover:text-neutral-100"
        >
          {namedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Named by the spec <span className="text-neutral-500">({data.named.length})</span>
        </button>
        {namedOpen && (
          <div className="flex max-h-56 flex-col gap-2 overflow-auto rounded border border-neutral-800 px-2 py-1.5">
            {namedGroups.map((g) => (
              <div key={g.key} className="flex flex-col">
                {/* The plan parent, so the list reads like the tree the
                    components live in rather than 161 sibling-less rows. */}
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
        )}
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-neutral-300">
          Reached through the plan links{' '}
          <span className="text-neutral-500">
            ({shownHops.length}
            {shownHops.length !== data.hops.length ? ` of ${data.hops.length}` : ''})
          </span>
        </p>
        {/* What each reach button will add, before it is clicked. The list only
            renders the radius in force, so without this the cost of widening it
            is invisible until you have already widened it. */}
        {distances.length > 1 && (
          <p className="text-[11px] text-neutral-500">
            {distances
              .map((d) => `${d.count} at ${d.depth} hop${d.depth === 1 ? '' : 's'}`)
              .join(' · ')}
          </p>
        )}
        {shownHops.length === 0 ? (
          <p className="text-xs text-neutral-600">
            The plan records no links out of the components the spec named.
          </p>
        ) : (
          <div className="flex max-h-96 flex-col gap-1 overflow-auto">
            {/* Keyed on the radius so a new reach re-derives which depth group
                starts open, the same thing the plan panel does. */}
            <PlanImpactList key={reach} hops={shownHops} hrefFor={href} />
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
