import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  planPatchSchema,
  type PlanNodeOrigin,
  type PlanPatch,
  type PlanPatchOp,
} from '../schemas/plan.js';
import { PlanPatchError } from './errors.js';
import {
  descendantPathSqlOffset,
  descendantsLikePattern,
  planNodePath,
  subtreeLikePattern,
  wouldDetachSubtree,
} from './paths.js';

type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
type UpsertOp = Extract<PlanPatchOp, { op: 'upsert' }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplyPlanPatchOptions {
  repositoryId: string;
  /** Who is writing. Stamped on CREATED nodes only — an LLM editing a
   *  human-authored node does not make the node the LLM's. */
  origin: PlanNodeOrigin;
  /** The task whose step produced this patch, if any. */
  sourceTaskId?: string | null;
}

export interface ApplyPlanPatchResult {
  created: string[];
  updated: string[];
  deleted: string[];
  linked: number;
  unlinked: number;
  /** patch-local ref -> real uuid, so a caller can report what an LLM's
   *  placeholder became and a chat transcript stays interpretable after the fact. */
  refs: Record<string, string>;
}

interface NodeRow {
  id: string;
  parentId: string | null;
  path: string;
  version: number;
}

/**
 * The ONE write path for plan nodes and edges.
 *
 * Every writer — an LLM plan step, a UI edit, the markdown import — goes through
 * here. That is not tidiness. `path` is a materialised ancestry that every
 * subtree read depends on, `version` is the only thing standing between two
 * concurrent plan chats and a lost edit, and a subtree move has to rewrite every
 * descendant in one statement. A second writer that got any one of those wrong
 * would corrupt the tree in a way no read could detect.
 *
 * Lives in `@haive/shared` rather than the worker because the api writes plans
 * too (manual node edits) and cannot import the worker. `db` is passed in, the
 * same arrangement `global-kb/task-context.ts` uses.
 *
 * Runs as ONE transaction: a patch is a unit of intent, and half of "create the
 * subtree, then link into it" is worse than none of it.
 */
export async function applyPlanPatch(
  db: Database,
  patchInput: unknown,
  opts: ApplyPlanPatchOptions,
): Promise<ApplyPlanPatchResult> {
  const parsed = planPatchSchema.safeParse(patchInput);
  if (!parsed.success) {
    throw new PlanPatchError('invalid', `plan patch failed validation: ${parsed.error.message}`);
  }
  return db.transaction(async (tx) => applyOps(tx, parsed.data, opts));
}

async function applyOps(
  tx: DbOrTx,
  patch: PlanPatch,
  opts: ApplyPlanPatchOptions,
): Promise<ApplyPlanPatchResult> {
  const { repositoryId, origin, sourceTaskId = null } = opts;
  const result: ApplyPlanPatchResult = {
    created: [],
    updated: [],
    deleted: [],
    linked: 0,
    unlinked: 0,
    refs: {},
  };
  /** patch-local ref (temp id or uuid) -> real uuid. */
  const refs = new Map<string, string>();
  /** Nodes deleted earlier in THIS patch. A later op naming one is a contract
   *  error, not a silent no-op — the model believed it still existed. */
  const dead = new Set<string>();

  async function loadNode(id: string): Promise<NodeRow | null> {
    const [row] = await tx
      .select({
        id: schema.planNodes.id,
        parentId: schema.planNodes.parentId,
        path: schema.planNodes.path,
        version: schema.planNodes.version,
      })
      .from(schema.planNodes)
      .where(and(eq(schema.planNodes.id, id), eq(schema.planNodes.repositoryId, repositoryId)))
      .limit(1);
    return row ?? null;
  }

  /** Resolve a ref to a live node. A uuid resolves to itself only if that node is
   *  in THIS repository — otherwise a patch could reach across repos. */
  async function resolveExisting(ref: string, opIndex: number): Promise<NodeRow> {
    const mapped = refs.get(ref);
    const id = mapped ?? (UUID_RE.test(ref) ? ref : null);
    if (!id) {
      throw new PlanPatchError(
        'invalid',
        `unknown node reference '${ref}' — a temporary id must be introduced by an earlier upsert`,
        opIndex,
      );
    }
    if (dead.has(id)) {
      throw new PlanPatchError(
        'invalid',
        `node '${ref}' was deleted earlier in this patch`,
        opIndex,
      );
    }
    const row = await loadNode(id);
    if (!row) throw new PlanPatchError('not_found', `plan node '${ref}' not found`, opIndex);
    return row;
  }

  function assertVersion(row: NodeRow, expected: number | undefined, opIndex: number): void {
    if (expected === undefined || row.version === expected) return;
    throw new PlanPatchError(
      'conflict',
      `plan node ${row.id} was modified by someone else ` +
        `(expected version ${expected}, found ${row.version})`,
      opIndex,
    );
  }

  async function nextOrdinal(parentId: string | null): Promise<number> {
    const [row] = await tx
      .select({ max: sql<number | null>`max(${schema.planNodes.ordinal})` })
      .from(schema.planNodes)
      .where(
        and(
          eq(schema.planNodes.repositoryId, repositoryId),
          parentId === null
            ? isNull(schema.planNodes.parentId)
            : eq(schema.planNodes.parentId, parentId),
        ),
      );
    return (row?.max ?? -1) + 1;
  }

  async function createNode(op: UpsertOp, opIndex: number): Promise<void> {
    if (!op.title) {
      throw new PlanPatchError('invalid', `new plan node '${op.nodeRef}' needs a title`, opIndex);
    }
    if (op.parentRef === undefined) {
      throw new PlanPatchError(
        'invalid',
        `new plan node '${op.nodeRef}' must say where it goes: parentRef null for the plan root, ` +
          'or the ref of its parent',
        opIndex,
      );
    }

    let parent: NodeRow | null = null;
    if (op.parentRef !== null) {
      parent = await resolveExisting(op.parentRef, opIndex);
    } else {
      // The partial unique index would reject this anyway; catching it here says
      // WHICH op is at fault and what to do instead.
      const [root] = await tx
        .select({ id: schema.planNodes.id })
        .from(schema.planNodes)
        .where(
          and(eq(schema.planNodes.repositoryId, repositoryId), isNull(schema.planNodes.parentId)),
        )
        .limit(1);
      if (root) {
        throw new PlanPatchError(
          'invalid',
          'this repository already has a plan root; parent the node under it instead of ' +
            'creating a second one',
          opIndex,
        );
      }
    }

    // The id is generated here rather than by the column default so `path` — which
    // embeds it — is correct in the SAME insert. A placeholder path patched by a
    // follow-up UPDATE would leave a row that briefly violates the one invariant
    // every subtree read depends on.
    const id = randomUUID();
    await tx.insert(schema.planNodes).values({
      id,
      repositoryId,
      parentId: parent?.id ?? null,
      path: planNodePath(parent?.path ?? null, id),
      ordinal: op.ordinal ?? (await nextOrdinal(parent?.id ?? null)),
      title: op.title,
      kind: op.kind ?? 'component',
      body: op.body ?? null,
      status: op.status ?? 'todo',
      taskable: op.taskable ?? false,
      createdBy: origin,
      sourceTaskId,
    });

    refs.set(op.nodeRef, id);
    result.created.push(id);
  }

  async function updateNode(op: UpsertOp, row: NodeRow, opIndex: number): Promise<void> {
    assertVersion(row, op.expectedVersion, opIndex);

    const set: Record<string, unknown> = {
      version: row.version + 1,
      updatedAt: new Date(),
      sourceTaskId,
    };
    if (op.title !== undefined) set.title = op.title;
    if (op.body !== undefined) set.body = op.body;
    if (op.kind !== undefined) set.kind = op.kind;
    if (op.status !== undefined) set.status = op.status;
    if (op.taskable !== undefined) set.taskable = op.taskable;
    if (op.ordinal !== undefined) set.ordinal = op.ordinal;

    if (op.parentRef !== undefined) {
      const newParent = op.parentRef === null ? null : await resolveExisting(op.parentRef, opIndex);
      const newParentId = newParent?.id ?? null;
      if (newParentId !== row.parentId) {
        if (!newParent) {
          throw new PlanPatchError(
            'invalid',
            'a node cannot be promoted to the plan root; a repository has exactly one root',
            opIndex,
          );
        }
        // Re-parenting a node under its own descendant detaches the subtree from
        // the tree entirely: every FK still holds while nothing is reachable from
        // the root, so no read could report it missing.
        if (wouldDetachSubtree(row.path, newParent.path)) {
          throw new PlanPatchError(
            'invalid',
            'cannot move a node underneath itself or one of its own descendants',
            opIndex,
          );
        }
        const newPrefix = planNodePath(newParent.path, row.id);
        set.parentId = newParentId;
        set.path = newPrefix;
        if (op.ordinal === undefined) set.ordinal = await nextOrdinal(newParentId);
        // Rewrite every DESCENDANT's ancestry in one prefix substitution, BEFORE
        // the node's own row moves — at this point they still carry the old
        // prefix. The pattern and the offset come from ./paths.ts so this SQL and
        // its JS counterpart cannot drift apart.
        await tx
          .update(schema.planNodes)
          .set({
            // The `::int` is NOT decoration. Postgres has two `substring`
            // overloads, (text, int) and (text, text) — the latter being the POSIX
            // REGEX form. A bound parameter arrives untyped, Postgres picks the
            // regex overload, the offset is matched as a pattern, nothing matches,
            // and the result is NULL — which then fails the NOT NULL on `path`
            // instead of silently writing a wrong ancestry. Verified against the
            // live server: `substring('/aaa/bbb/ccc/' from $1)` with an untyped
            // '5' returns NULL; with `$1::int` it returns '/bbb/ccc/'.
            path: sql`${newPrefix} || substring(${schema.planNodes.path} from ${descendantPathSqlOffset(row.path)}::int)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.planNodes.repositoryId, repositoryId),
              sql`${schema.planNodes.path} LIKE ${descendantsLikePattern(row.path)}`,
            ),
          );
      }
    }

    await tx.update(schema.planNodes).set(set).where(eq(schema.planNodes.id, row.id));
    refs.set(op.nodeRef, row.id);
    if (!result.updated.includes(row.id)) result.updated.push(row.id);
  }

  async function applyUpsert(op: UpsertOp, opIndex: number): Promise<void> {
    const known = refs.get(op.nodeRef);
    const candidateId = known ?? (UUID_RE.test(op.nodeRef) ? op.nodeRef : null);
    const existing = candidateId && !dead.has(candidateId) ? await loadNode(candidateId) : null;

    if (existing) {
      await updateNode(op, existing, opIndex);
      return;
    }
    // A uuid ref resolving to nothing is a STALE id, not a request to create a
    // node with it: creating one would resurrect something the author believed
    // still existed, under an id other rows may already reference.
    if (!known && candidateId) {
      throw new PlanPatchError('not_found', `plan node '${op.nodeRef}' not found`, opIndex);
    }
    await createNode(op, opIndex);
  }

  for (const [opIndex, op] of patch.ops.entries()) {
    switch (op.op) {
      case 'upsert':
        await applyUpsert(op, opIndex);
        break;

      case 'delete': {
        const row = await resolveExisting(op.nodeRef, opIndex);
        assertVersion(row, op.expectedVersion, opIndex);
        // The subtree goes with it via the parent_id cascade. Collect the ids
        // first so a later op in the same patch cannot reference a descendant
        // that no longer exists.
        const doomed = await tx
          .select({ id: schema.planNodes.id })
          .from(schema.planNodes)
          .where(
            and(
              eq(schema.planNodes.repositoryId, repositoryId),
              sql`${schema.planNodes.path} LIKE ${subtreeLikePattern(row.path)}`,
            ),
          );
        await tx.delete(schema.planNodes).where(eq(schema.planNodes.id, row.id));
        for (const d of doomed) dead.add(d.id);
        result.deleted.push(row.id);
        break;
      }

      case 'link': {
        const from = await resolveExisting(op.fromRef, opIndex);
        const to = await resolveExisting(op.toRef, opIndex);
        if (from.id === to.id) {
          throw new PlanPatchError('invalid', 'a node cannot link to itself', opIndex);
        }
        const inserted = await tx
          .insert(schema.planNodeEdges)
          .values({
            repositoryId,
            fromNodeId: from.id,
            toNodeId: to.id,
            kind: op.kind,
            note: op.note ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: schema.planNodeEdges.id });
        result.linked += inserted.length;
        break;
      }

      case 'unlink': {
        const from = await resolveExisting(op.fromRef, opIndex);
        const to = await resolveExisting(op.toRef, opIndex);
        const removed = await tx
          .delete(schema.planNodeEdges)
          .where(
            and(
              eq(schema.planNodeEdges.repositoryId, repositoryId),
              eq(schema.planNodeEdges.fromNodeId, from.id),
              eq(schema.planNodeEdges.toNodeId, to.id),
              eq(schema.planNodeEdges.kind, op.kind),
            ),
          )
          .returning({ id: schema.planNodeEdges.id });
        result.unlinked += removed.length;
        break;
      }
    }
  }

  result.refs = Object.fromEntries(refs);
  return result;
}

/** A repository's plan root, or null when it has no plan yet. Used by the build
 *  step (replace vs merge), by the onboarding wrapper's `shouldRun`, and by the
 *  mirror import's "only when empty" guard. */
export async function findPlanRoot(
  db: Database,
  repositoryId: string,
): Promise<{ id: string; title: string } | null> {
  const [row] = await db
    .select({ id: schema.planNodes.id, title: schema.planNodes.title })
    .from(schema.planNodes)
    .where(and(eq(schema.planNodes.repositoryId, repositoryId), isNull(schema.planNodes.parentId)))
    .orderBy(asc(schema.planNodes.createdAt))
    .limit(1);
  return row ?? null;
}
