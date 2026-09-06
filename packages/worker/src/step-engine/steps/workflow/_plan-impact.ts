import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import {
  IMPACT_DEFAULT_VIEW_DEPTH,
  loadPlanCodeLinks,
  type PlanCodeLinkRecord,
} from '@haive/shared/plan';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

/**
 * "What else stands on the thing you are about to change?"
 *
 * The plan canvas exists partly to answer that, and it computed the answer long
 * before anything used it: `04-phase-0b` walks the edge graph from the components
 * the spec named, and `06-gate-1-spec-approval` renders the result — to a HUMAN.
 * The implementer, the one agent that could act on it before the damage, was
 * never told. Nor was any agent ever shown a `plan_node_code_links` row, so even
 * a component the spec did name arrived as a title with no way to go and look.
 *
 * This is the block that closes that. A loader plus a pure formatter, the same
 * split `_impl-changes.ts` uses, so the wording is testable without a database.
 *
 * Best-effort THROUGHOUT. A repo with no plan, a spec that named nothing, a
 * disabled canvas or a failed query all produce `''`, and a prompt with `''`
 * spliced into it is byte-identical to the one that shipped before this existed.
 * Blast radius is context; it must never be able to fail a step.
 */

/** How many components the block may list. This is read by a coder in the middle
 *  of a much longer prompt, not browsed — past a dozen it stops being a warning
 *  and becomes scenery. Over the cap the count is STATED, never silently cut. */
export const PLAN_IMPACT_MAX_NODES = 12;

/** Files per component. A node with forty links is a container someone linked a
 *  whole directory to; the first few plus a count is the useful form. */
export const PLAN_IMPACT_MAX_LINKS_PER_NODE = 6;

export interface PlanImpactLink {
  repoPath: string;
  symbol: string | null;
  /** A task changed this path since an agent last asserted the link. Carried, not
   *  filtered: that is simultaneously the most useful pointer and the least
   *  trustworthy one, and only the reader can weigh it. */
  stale: boolean;
}

export interface PlanImpactConsumer {
  title: string;
  /** 0 = the spec named it; 1 = the plan's edges reached it in one hop. */
  depth: number;
  /** The edge kind that implicated it, or null for a spec-named component. */
  via: string | null;
  links: PlanImpactLink[];
  /** Links this component has beyond the per-node cap. */
  linksOmitted: number;
}

export interface PlanImpactContext {
  consumers: PlanImpactConsumer[];
  /** Components past `PLAN_IMPACT_MAX_NODES`, stated rather than dropped. */
  nodesOmitted: number;
  /** Components the graph reaches further out than the listed depth. Counted on
   *  purpose — see `depthNote` below. */
  deeperCount: number;
  /** Where the set came from. `links` means 04's output was gone (a Retry cascade
   *  nulls step output) and the durable `plan_node_tasks` rows were used instead,
   *  which carry no depth or edge kind. The block says so rather than presenting
   *  a flattened set as if it were measured. */
  source: 'spec' | 'links';
  /** 04's own traversal hit a cap. Carried through so a short list is never read
   *  as "nothing else is affected" — the same rule the gate-1 render follows. */
  walkTruncated: boolean;
}

interface AffectedComponentsOutput {
  named?: { id: string; title: string }[];
  reached?: { id: string; title: string; depth: number; via: string }[];
  truncated?: null | { reason: string; limit: number };
}

/**
 * Assemble the context for this task, or null when there is nothing to say.
 *
 * Source precedence is deliberate. 04's `affectedComponents` comes first because
 * it carries the hop count and the edge kind, and because it is exactly what the
 * approver saw at gate 1 — agent and human reading different blast radii would be
 * worse than either reading none. `_step-reset` nulls step output on a Retry
 * cascade though, so the fallback is the `plan_node_tasks` rows, which survive;
 * `11f-plan-reconcile` reads them for the same reason.
 */
export async function loadPlanImpactContext(ctx: StepContext): Promise<PlanImpactContext | null> {
  try {
    if ((await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) === false) {
      return null;
    }
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    if (!task?.repositoryId) return null;

    const fromSpec = await loadFromSpecOutput(ctx);
    const picked = fromSpec ?? (await loadFromTaskLinks(ctx));
    if (!picked || picked.entries.length === 0) return null;

    const listed = picked.entries.slice(0, PLAN_IMPACT_MAX_NODES);
    const links = await loadPlanCodeLinks(
      ctx.db,
      listed.map((e) => e.id),
    );
    const byNode = new Map<string, PlanCodeLinkRecord[]>();
    for (const link of links) {
      const run = byNode.get(link.nodeId);
      if (run) run.push(link);
      else byNode.set(link.nodeId, [link]);
    }

    return {
      consumers: listed.map((entry) => {
        const all = byNode.get(entry.id) ?? [];
        return {
          title: entry.title,
          depth: entry.depth,
          via: entry.via,
          links: all.slice(0, PLAN_IMPACT_MAX_LINKS_PER_NODE).map((l) => ({
            repoPath: l.repoPath,
            symbol: l.symbol,
            stale: l.stale,
          })),
          linksOmitted: Math.max(0, all.length - PLAN_IMPACT_MAX_LINKS_PER_NODE),
        };
      }),
      nodesOmitted: Math.max(0, picked.entries.length - listed.length),
      deeperCount: picked.deeperCount,
      source: picked.source,
      walkTruncated: picked.walkTruncated,
    };
  } catch (err) {
    ctx.logger.warn({ err }, 'plan impact context unavailable (non-fatal)');
    return null;
  }
}

interface PickedEntry {
  id: string;
  title: string;
  depth: number;
  via: string | null;
}
interface Picked {
  entries: PickedEntry[];
  deeperCount: number;
  source: 'spec' | 'links';
  walkTruncated: boolean;
}

/**
 * 04's answer, trimmed to the hops worth showing.
 *
 * Only `IMPACT_DEFAULT_VIEW_DEPTH` hops are LISTED, and the rest are counted.
 * `impact.ts` carries the measurement behind that constant: on a real 226-node,
 * 530-edge plan one hop reaches a median of 3 nodes and two reach a median of 130,
 * because the graph is hub-shaped. A transitive list is "essentially the whole
 * plan", which warns about nothing while costing the prompt budget that would have
 * carried the useful part.
 */
async function loadFromSpecOutput(ctx: StepContext): Promise<Picked | null> {
  const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
  const affected = (row?.output as { affectedComponents?: AffectedComponentsOutput } | null)
    ?.affectedComponents;
  if (!affected) return null;
  const named = affected.named ?? [];
  const reached = affected.reached ?? [];
  if (named.length === 0 && reached.length === 0) return null;

  const near = reached.filter((r) => r.depth <= IMPACT_DEFAULT_VIEW_DEPTH);
  return {
    entries: [
      ...named.map((n) => ({ id: n.id, title: n.title, depth: 0, via: null })),
      ...near.map((r) => ({ id: r.id, title: r.title, depth: r.depth, via: r.via })),
    ],
    deeperCount: reached.length - near.length,
    source: 'spec',
    walkTruncated: affected.truncated != null,
  };
}

/**
 * The durable fallback: every node this task is linked to.
 *
 * `recordTouchedPlanNodes` writes the union of named and reached as `touched`, so
 * these rows ARE the affected set — flattened. The hop count and edge kind are
 * gone, which is why every entry reports depth 0 with no `via` and the block
 * states that it is working from the recorded links.
 */
async function loadFromTaskLinks(ctx: StepContext): Promise<Picked | null> {
  const rows = await ctx.db
    .select({ nodeId: schema.planNodeTasks.nodeId, title: schema.planNodes.title })
    .from(schema.planNodeTasks)
    .innerJoin(schema.planNodes, eq(schema.planNodes.id, schema.planNodeTasks.nodeId))
    .where(eq(schema.planNodeTasks.taskId, ctx.taskId));
  if (rows.length === 0) return null;
  return {
    entries: rows.map((r) => ({ id: r.nodeId, title: r.title, depth: 0, via: null })),
    deeperCount: 0,
    source: 'links',
    walkTruncated: false,
  };
}

/** How the edge kind reads in a sentence. The stored values are snake_case enum
 *  members and `depends_on` in particular reads backwards to a person skimming. */
const VIA_PHRASE: Record<string, string> = {
  depends_on: 'depends on it',
  affects: 'is affected by changes to it',
  implements: 'implements it',
};

export interface PlanImpactBlockOptions {
  /**
   * True for a DAG coder, which owns ONE issue in ONE worktree that is merged at a
   * level barrier. Editing a file another issue owns produces a merge conflict, and
   * the coder is told elsewhere that git is unavailable to it — so for those the
   * block is strictly read-only and routes a needed change into `concerns`.
   *
   * False for the single implementation agent, which holds the whole worktree and
   * whose scope fence already puts a consumer of a changed contract in scope.
   */
  isolated: boolean;
}

/**
 * The block, as an agent reads it. Pure — everything it needs is in `context`.
 *
 * Deliberately not phrased as work. The listed components are not this task's
 * scope; they are what the plan says will feel it if a shared contract moves.
 * Telling an agent to "update the affected components" would widen every diff by
 * the size of the blast radius, which is the failure the scope fence exists to
 * prevent.
 */
export function planImpactBlock(
  context: PlanImpactContext | null,
  opts: PlanImpactBlockOptions,
): string {
  if (!context || context.consumers.length === 0) return '';

  const lines: string[] = [
    '=== What else stands on this (from the project plan) ===',
    'The plan records these components around the part you are changing. They are NOT your',
    'scope and most changes leave them alone — they are here so a contract you move does not',
    'break them silently.',
    '',
  ];

  for (const c of context.consumers) {
    const provenance =
      c.depth === 0
        ? context.source === 'links'
          ? 'linked to this task'
          : 'named by the spec'
        : `${VIA_PHRASE[c.via ?? ''] ?? c.via ?? 'linked'}, ${c.depth} hop${c.depth === 1 ? '' : 's'} away`;
    lines.push(`- ${c.title} — ${provenance}`);
    for (const link of c.links) {
      const where = link.symbol ? `${link.repoPath} — ${link.symbol}` : link.repoPath;
      lines.push(
        link.stale
          ? `    ${where}  [STALE: a task changed this path since the link was confirmed; verify it still applies]`
          : `    ${where}`,
      );
    }
    if (c.links.length === 0) {
      lines.push(
        '    (no files recorded for this component — search for it if your change reaches it)',
      );
    }
    if (c.linksOmitted > 0) {
      lines.push(
        `    …and ${c.linksOmitted} more file${c.linksOmitted === 1 ? '' : 's'} not listed here`,
      );
    }
  }

  // Every cap and every gap is stated. A short list read as "nothing else is
  // affected" is the exact failure this whole feature exists to prevent, so it
  // must never be reachable by silence.
  const notes: string[] = [];
  if (context.nodesOmitted > 0) {
    notes.push(
      `${context.nodesOmitted} further component${context.nodesOmitted === 1 ? '' : 's'} are affected and not listed above.`,
    );
  }
  if (context.deeperCount > 0) {
    notes.push(
      `${context.deeperCount} more sit further out in the plan than one hop and are not listed; ask for them if your change alters something widely shared.`,
    );
  }
  if (context.walkTruncated) {
    notes.push('The plan traversal hit its own limit, so even this wider count is a floor.');
  }
  if (context.source === 'links') {
    notes.push(
      'These came from the components recorded against this task rather than a fresh traversal, so they carry no hop count.',
    );
  }
  if (notes.length > 0) lines.push('', ...notes.map((n) => `NOTE: ${n}`));

  lines.push(
    '',
    opts.isolated
      ? 'Do NOT edit these files — they belong to other issues in this run and editing them causes a merge conflict at the level barrier. Read them if your change alters something they rely on, and if one genuinely needs a change, say so in `concerns` instead of making it.'
      : 'If your change alters a contract one of these relies on, fixing it is part of THIS change — that is already in scope. If it does not, leave it alone.',
  );

  return lines.join('\n');
}
