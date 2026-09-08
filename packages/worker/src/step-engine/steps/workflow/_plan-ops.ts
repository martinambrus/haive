import { isPlanNodeId, stripNodeRefPrefix } from '@haive/shared/plan';
import { parsePlanPatch } from '../plan/_plan-prompt.js';

/**
 * Rendering and bounds for a proposed plan patch, shared by the two steps that offer one
 * to a developer: 11f-plan-reconcile (what THIS task changed) and 01f-external-plan-sync
 * (what reached the repository without Haive). Both put the same tick list in front of a
 * person, so the label they read must be produced in one place — a second copy would be a
 * second chance to describe an op as something other than what ticking it does.
 */

/** A patch bigger than this is not a reconcile, it is a rewrite, and no one can
 *  review it in a form. The agent is told the limit; this is the backstop. */
export const MAX_PROPOSED_OPS = 40;

type ProposedOp = Record<string, unknown>;

/** The proposals, however the runner hands them over. */
export function proposedOps(llmOutput: unknown): ProposedOp[] {
  const patch = parsePlanPatch(llmOutput);
  if (!patch) return [];
  return patch.ops.slice(0, MAX_PROPOSED_OPS) as ProposedOp[];
}

/**
 * One proposed op as a line a person can judge without reading JSON.
 *
 * Exported for its own test: this is the only thing standing between the
 * developer and approving something they did not understand, so an op shape it
 * cannot describe must say so rather than render as an empty tick box.
 */
/** `text` as an inline code span, so a form label can set a node title or a path
 *  apart from the prose around it. The fence is sized to the content because
 *  titles are written by people and agents: a one-backtick fence around a title
 *  that contains one ends the span early and spills markdown into the label. */
function code(text: string): string {
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function describePlanOp(op: ProposedOp, titleById: Map<string, string>): string {
  // Refs arrive as the agent wrote them — `parsePlanPatch` normalises nothing,
  // and the patch contract tells the agent to quote ids as `node:<uuid>`, which
  // apply-patch measured as the common shape. Both the id test below and the
  // title lookup want the bare id, so strip with the same function apply uses.
  const bare = (ref: unknown): string | null =>
    typeof ref === 'string' ? stripNodeRefPrefix(ref) : null;
  const name = (ref: unknown): string => {
    const id = bare(ref);
    if (id === null) return 'a node';
    // Bold as well as code: the paths further along the line are code too, and
    // the node is what the reader is scanning a list of these for.
    return `**${code(titleById.get(id) ?? `${id.slice(0, 8)}…`)}**`;
  };
  switch (op.op) {
    case 'upsert': {
      // Decided on the REF SHAPE, the same rule `applyUpsert` applies — a uuid
      // names a node that already exists. Asking the title map instead made the
      // answer depend on a DISPLAY resource: a form built with an empty one
      // rendered every status and code-link update as `Add node "untitled"
      // under a node`, which is not what ticking the box would have done.
      if (!isPlanNodeId(bare(op.nodeRef))) {
        return `Add node **${code(String(op.title ?? 'untitled'))}** under ${name(op.parentRef)}`;
      }
      const parts: string[] = [];
      if (op.status) parts.push(`mark ${String(op.status)}`);
      if (op.taskable !== undefined) parts.push(op.taskable ? 'mark taskable' : 'unmark taskable');
      if (op.title) parts.push('rename');
      if (op.body !== undefined) parts.push('rewrite its description');
      if (Array.isArray(op.codeLinks)) {
        // Split by role rather than listing paths flat: "link X" and "link X as a
        // test that covers this" are different claims, and the developer ticking
        // the box can only judge the one they can see.
        const byRole = { implements: [] as string[], covers: [] as string[] };
        for (const raw of op.codeLinks) {
          const link = raw as { repoPath?: unknown; role?: unknown };
          if (typeof link.repoPath !== 'string') continue;
          byRole[link.role === 'covers' ? 'covers' : 'implements'].push(link.repoPath);
        }
        const paths = (list: string[]): string => list.map(code).join(', ');
        if (byRole.implements.length > 0) parts.push(`link ${paths(byRole.implements)}`);
        if (byRole.covers.length > 0) parts.push(`link tests ${paths(byRole.covers)}`);
      }
      return `Update ${name(op.nodeRef)}: ${parts.length > 0 ? parts.join('; ') : 'no visible change'}`;
    }
    case 'link':
      return `Link ${name(op.fromRef)} → ${name(op.toRef)} (${String(op.kind)})`;
    case 'unlink':
      return `Remove the ${String(op.kind)} link ${name(op.fromRef)} → ${name(op.toRef)}`;
    case 'delete':
      return `Delete ${name(op.nodeRef)} and everything under it`;
    default:
      // Never a silent empty label: an op nobody can read is one nobody should
      // be able to approve by accident.
      return `Unrecognised change (${String(op.op ?? 'no op')}) — leave this unticked`;
  }
}
