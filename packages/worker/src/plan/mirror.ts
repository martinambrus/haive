import { createHash } from 'node:crypto';
import {
  readFileNoFollow,
  readTextNoFollow,
  removeNoFollow,
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  HAIVE_DATA_FILES,
  PLAN_MIRROR_SCHEMA_VERSION,
  logger,
  type PlanMirror,
  type PlanPullOutcome,
} from '@haive/shared';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import {
  loadPlanEdges,
  loadPlanNodes,
  markPlanMirrorDirty,
  renderPlanMarkdownFrom,
  planNodePath,
} from '@haive/shared/plan';
import { gitOperationInProgress } from '../repo/git-operation.js';

/**
 * The committed `.haive-data/` projection of a repository's plan.
 *
 * Two files, deliberately:
 *   - `plan.json` is the machine-readable restore point. Node ids are opaque
 *     snapshot-local references; this importer currently preserves them, but
 *     portable consumers only rely on their hierarchy/link connectivity.
 *   - `plan.md` is the SAME render the plan agents are prompted with, committed
 *     so a human reading the repo sees exactly what the agents see. A JSON blob
 *     is unreadable in a diff; a markdown doc cannot be re-imported losslessly.
 *     Hence both, from one source.
 */

export interface PlanMirrorChanges {
  written: string[];
  removed: string[];
}

/** A flush that wrote nothing on purpose; the row stays dirty and `last_error` says why. */
export class PlanMirrorHeldError extends Error {
  override readonly name = 'PlanMirrorHeldError';
}

const hashBytes = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

// Stamped when the files were removed, so a plan.json that arrives later reads as unimported.
const ABSENT_HASH = hashBytes('');

const HELD_UNIMPORTED =
  "the checkout's plan.json holds changes Haive has not read in; Pull the plan to bring them in. Nothing was written.";
const HELD_GIT_OPERATION =
  'a merge or rebase is open in the checkout; nothing was written. The plan is written again once it finishes.';

async function assertFlushMayWrite(
  repoPath: string,
  syncedHash: string | null,
  nextJson: string | null,
): Promise<void> {
  if (await gitOperationInProgress(repoPath)) throw new PlanMirrorHeldError(HELD_GIT_OPERATION);
  const onDisk = await readFileNoFollow(repoPath, HAIVE_DATA_FILES.plan);
  if (onDisk === null) return;
  if (!flushMayReplace(repoPath, onDisk.data, syncedHash, nextJson)) {
    throw new PlanMirrorHeldError(HELD_UNIMPORTED);
  }
}

function flushMayReplace(
  repoPath: string,
  onDisk: Buffer,
  syncedHash: string | null,
  nextJson: string | null,
): boolean {
  const diskHash = hashBytes(onDisk);
  if (diskHash === syncedHash || (nextJson !== null && diskHash === hashBytes(nextJson)))
    return true;
  if (syncedHash !== null) return false;
  logger.warn({ repoPath }, 'plan.json differs from the database and was never stamped; adopting');
  return true;
}

/** Removes plan.json only while it still holds bytes the flush may replace, judged on the file removed. */
export async function removePlanJsonIfUnchanged(
  repoPath: string,
  syncedHash: string | null,
): Promise<void> {
  let operation = false;
  const outcome = await removeFileIfNoFollow(repoPath, HAIVE_DATA_FILES.plan, async (data) => {
    operation = await gitOperationInProgress(repoPath);
    return !operation && flushMayReplace(repoPath, data, syncedHash, null);
  });
  if (outcome === 'kept') {
    throw new PlanMirrorHeldError(operation ? HELD_GIT_OPERATION : HELD_UNIMPORTED);
  }
}

/** Replaces plan.json only while it still holds bytes the flush may replace, judged on the file it
 *  holds, so bytes a pull lands after the early check are never written over. */
export async function writePlanJsonIfUnchanged(
  repoPath: string,
  json: string,
  syncedHash: string | null,
): Promise<void> {
  const bytes = Buffer.from(json, 'utf8');
  let operation = false;
  // The merge check is repeated here, after the file is parked, so it sits next to the replace.
  const outcome = await rewriteFileIfNoFollow(repoPath, HAIVE_DATA_FILES.plan, async (data) => {
    operation = await gitOperationInProgress(repoPath);
    if (operation) return null;
    return flushMayReplace(repoPath, data, syncedHash, json) ? bytes : null;
  });
  if (outcome === 'kept') {
    throw new PlanMirrorHeldError(operation ? HELD_GIT_OPERATION : HELD_UNIMPORTED);
  }
  if (outcome === 'rewritten') return;
  try {
    await writeFileNoFollow(repoPath, HAIVE_DATA_FILES.plan, bytes, {
      mode: 'create-exclusive',
      createParents: true,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PlanMirrorHeldError(HELD_UNIMPORTED);
    }
    throw err;
  }
}

async function stampSyncedHash(
  db: Pick<Database, 'update'>,
  repositoryId: string,
  hash: string,
): Promise<void> {
  await db
    .update(schema.planMirrorState)
    .set({ syncedHash: hash })
    .where(eq(schema.planMirrorState.repositoryId, repositoryId));
}

/** The two files as the database would write them now, or null when there is no plan. */
async function renderPlanMirrorFiles(
  db: PlanMirrorTx,
  repositoryId: string,
): Promise<{ json: string; markdown: string } | null> {
  const [nodes, edges, codeLinks] = await Promise.all([
    loadPlanNodes(db, repositoryId),
    loadPlanEdges(db, repositoryId),
    db
      .select({
        nodeId: schema.planNodeCodeLinks.nodeId,
        repoPath: schema.planNodeCodeLinks.repoPath,
        symbol: schema.planNodeCodeLinks.symbol,
        evidence: schema.planNodeCodeLinks.evidence,
        derivedAtCommit: schema.planNodeCodeLinks.derivedAtCommit,
        stale: schema.planNodeCodeLinks.stale,
        role: schema.planNodeCodeLinks.role,
      })
      .from(schema.planNodeCodeLinks)
      .where(eq(schema.planNodeCodeLinks.repositoryId, repositoryId)),
  ]);
  if (nodes.length === 0) return null;

  // `createdAt` is intentionally not portable, but legacy/manual rows can have
  // duplicate or gapped ordinals whose tie-breaker used that timestamp. Compact
  // each sibling run in the already-loaded display order so the clone preserves
  // what the user saw without exporting audit timestamps.
  const nextOrdinalByParent = new Map<string, number>();
  const portableNodes = nodes.map((n) => {
    const parentKey = n.parentId ?? '<root>';
    const ordinal = nextOrdinalByParent.get(parentKey) ?? 0;
    nextOrdinalByParent.set(parentKey, ordinal + 1);
    return {
      id: n.id,
      parentId: n.parentId,
      ordinal,
      title: n.title,
      kind: n.kind,
      body: n.body,
      status: n.status,
      taskable: n.taskable,
    };
  });

  const mirror: PlanMirror = planMirrorV2Schema.parse({
    schemaVersion: PLAN_MIRROR_SCHEMA_VERSION,
    nodes: portableNodes,
    edges: edges.map((e) => ({
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      kind: e.kind,
      note: e.note,
    })),
    codeLinks,
  });
  return {
    json: `${JSON.stringify(mirror, null, 2)}\n`,
    markdown: renderPlanMarkdownFrom(nodes, edges),
  };
}

/** Write both mirror files. Returns the repo-relative paths written; `changes`, when given,
 *  also collects what was written or removed up to a throw. */
export async function writePlanMirror(
  db: Database,
  repositoryId: string,
  repoPath: string,
  changes?: PlanMirrorChanges,
): Promise<string[]> {
  try {
    const result = await db.transaction(async (tx) => {
      // Every writer (queue, plan steps, onboarding) enters here. Serialize per
      // repository across worker processes so an older render can never rename
      // over a newer one after the newer writer already marked itself current.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`);
      return writePlanMirrorLocked(tx, repositoryId, repoPath, changes);
    });
    // Thrown only once the stamp of the plan.json that landed is committed.
    if (result.failed !== undefined) throw result.failed;
    return result.written;
  } catch (err) {
    await recordPlanMirrorError(db, repositoryId, err).catch(() => undefined);
    throw err;
  }
}

type PlanMirrorTx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function writePlanMirrorLocked(
  db: PlanMirrorTx,
  repositoryId: string,
  repoPath: string,
  changes?: PlanMirrorChanges,
): Promise<{ written: string[]; failed?: unknown }> {
  let [state] = await db
    .select()
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  if (!state) {
    const [created] = await db
      .insert(schema.planMirrorState)
      .values({ repositoryId, revision: 1, writtenRevision: 0 })
      .onConflictDoNothing()
      .returning();
    if (created) state = created;
    else {
      [state] = await db
        .select()
        .from(schema.planMirrorState)
        .where(eq(schema.planMirrorState.repositoryId, repositoryId))
        .limit(1);
    }
  }
  const targetRevision = Math.max(1, state?.revision ?? 1);

  const rendered = await renderPlanMirrorFiles(db, repositoryId);
  await assertFlushMayWrite(repoPath, state?.syncedHash ?? null, rendered?.json ?? null);

  if (!rendered) {
    await removePlanJsonIfUnchanged(repoPath, state?.syncedHash ?? null);
    changes?.removed.push(HAIVE_DATA_FILES.plan);
    await stampSyncedHash(db, repositoryId, ABSENT_HASH);
    try {
      await removeNoFollow(repoPath, HAIVE_DATA_FILES.planMarkdown);
    } catch (err) {
      return { written: [], failed: err };
    }
    changes?.removed.push(HAIVE_DATA_FILES.planMarkdown);
    await db
      .update(schema.planMirrorState)
      .set({
        writtenRevision: targetRevision,
        lastError: null,
        writtenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.planMirrorState.repositoryId, repositoryId),
          eq(schema.planMirrorState.revision, targetRevision),
        ),
      );
    return { written: [] };
  }

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    // `replace-atomic` is the DEFAULT mode and is exactly what this hand-rolled dance did — write a
    // temp beside the target, rename over it, unlink the temp on failure — so a concurrent reader
    // still sees either the old bytes or the new ones, never a half-written mirror.
    await writeFileNoFollow(repoPath, rel, content, { createParents: true });
    written.push(rel);
    changes?.written.push(rel);
  };

  await writePlanJsonIfUnchanged(repoPath, rendered.json, state?.syncedHash ?? null);
  written.push(HAIVE_DATA_FILES.plan);
  changes?.written.push(HAIVE_DATA_FILES.plan);
  await stampSyncedHash(db, repositoryId, hashBytes(rendered.json));
  // A failed plan.md leaves the row dirty but keeps the stamp of the plan.json that landed.
  try {
    await write(HAIVE_DATA_FILES.planMarkdown, rendered.markdown);
  } catch (err) {
    return { written, failed: err };
  }
  // Conditional on the revision we rendered. A mutation that raced the file
  // write leaves the row dirty and the scheduled sweep immediately retries.
  await db
    .update(schema.planMirrorState)
    .set({
      writtenRevision: targetRevision,
      lastError: null,
      writtenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.planMirrorState.repositoryId, repositoryId),
        eq(schema.planMirrorState.revision, targetRevision),
      ),
    );
  return { written };
}

/** Only `refused` is worth telling a person: every rescan meets no snapshot or an existing plan. */
export type PlanMirrorImport =
  | { imported: true }
  | { imported: false; code: 'no_mirror' | 'has_plan' | 'refused'; reason: string };

const refused = (reason: string): PlanMirrorImport => ({
  imported: false,
  code: 'refused',
  reason,
});

/**
 * Restore a plan from a fresh clone's committed mirror.
 *
 * This is the ONE writer that does not go through `applyPlanPatch`, and the
 * reason is the point of a mirror: it restores the complete portable model in
 * one transaction. The current v2 importer preserves opaque refs, and the patch
 * contract intentionally cannot express "create this node with exactly this id".
 *
 * Non-clobbering and schemaVersion-gated, exactly like the onboarding mirror
 * branches it sits beside: it runs only when the repository has no plan rows at
 * all, so a live local plan (or an earlier import) is never overwritten and a
 * re-scan is a no-op.
 */
export async function importPlanMirror(
  db: Database,
  repositoryId: string,
  storagePath: string,
): Promise<PlanMirrorImport> {
  let rawPayload: unknown;
  let rawText: string;
  try {
    // null is absence OR a refusal — a link, a non-regular file — and both mean there is no mirror
    // to import, which is exactly what the `catch` concluded for an unreadable path.
    const raw = await readTextNoFollow(storagePath, HAIVE_DATA_FILES.plan);
    if (raw === null) return { imported: false, code: 'no_mirror', reason: 'no plan mirror' };
    rawText = raw;
    rawPayload = JSON.parse(raw) as unknown;
  } catch {
    return { imported: false, code: 'no_mirror', reason: 'no plan mirror' };
  }

  const parsed = planMirrorPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const version = (rawPayload as { schemaVersion?: unknown } | null)?.schemaVersion;
    return refused(
      version !== 1 && version !== PLAN_MIRROR_SCHEMA_VERSION
        ? `schemaVersion ${String(version)} not supported`
        : `invalid plan mirror: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    );
  }
  const mirror = parsed.data;
  const mirrorNodes =
    mirror.schemaVersion === 1
      ? mirror.nodes.map((node) => ({ ...node, createdBy: node.createdBy }))
      : mirror.nodes.map((node) => ({ ...node, createdBy: 'import' as const }));
  if (!Array.isArray(mirror.nodes) || mirror.nodes.length === 0) {
    return refused('mirror has no nodes');
  }

  const roots = mirrorNodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) {
    return refused(`plan mirror must contain exactly one root (found ${roots.length})`);
  }
  const ids = mirrorNodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return refused('plan mirror contains duplicate node refs');
  }
  for (const edge of mirror.edges) {
    if (!uniqueIds.has(edge.fromNodeId) || !uniqueIds.has(edge.toNodeId)) {
      return refused('plan mirror contains a dangling plan link');
    }
    if (edge.fromNodeId === edge.toNodeId) {
      return refused('plan mirror contains a self-referencing plan link');
    }
  }
  const codeLinks = mirror.schemaVersion === 2 ? mirror.codeLinks : [];
  for (const link of codeLinks) {
    if (!uniqueIds.has(link.nodeId)) {
      return refused('plan mirror contains a dangling code link');
    }
  }
  const edgeKeys = mirror.edges.map((edge) =>
    [edge.fromNodeId, edge.toNodeId, edge.kind].join('\0'),
  );
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    return refused('plan mirror contains duplicate plan links');
  }
  const codeLinkKeys = codeLinks.map((link) =>
    [link.nodeId, link.repoPath, link.symbol ?? ''].join('\0'),
  );
  if (new Set(codeLinkKeys).size !== codeLinkKeys.length) {
    return refused('plan mirror contains duplicate code links');
  }

  const [existing] = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .limit(1);
  if (existing) {
    return { imported: false, code: 'has_plan', reason: 'repository already has a plan' };
  }

  // The ids are restored verbatim, and a node id is globally unique — so adding
  // the SAME repository twice would collide on the primary key. That is not a
  // restore, it is a duplicate, and a partial insert (onConflictDoNothing) would
  // leave a tree missing exactly the nodes that matter. Refuse the whole import
  // and say so.
  const clashes = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(inArray(schema.planNodes.id, ids))
    .limit(1);
  if (clashes.length > 0) {
    return refused('these plan nodes already exist under another repository');
  }

  // Order parents before children so `path` can be built from the parent's, and
  // reject a mirror whose parentage does not close — a cycle or a dangling parent
  // would otherwise import a silently truncated tree.
  const byId = new Map(mirrorNodes.map((n) => [n.id, n]));
  const pathById = new Map<string, string>();
  const ordered: typeof mirrorNodes = [];
  const resolving = new Set<string>();

  const place = (id: string): boolean => {
    if (pathById.has(id)) return true;
    if (resolving.has(id)) return false;
    const node = byId.get(id);
    if (!node) return false;
    resolving.add(id);
    let parentPath: string | null = null;
    if (node.parentId !== null) {
      if (!place(node.parentId)) {
        resolving.delete(id);
        return false;
      }
      parentPath = pathById.get(node.parentId)!;
    }
    resolving.delete(id);
    pathById.set(id, planNodePath(parentPath, id));
    ordered.push(node);
    return true;
  };
  for (const n of mirrorNodes) {
    if (!place(n.id)) {
      return refused(`plan mirror parentage does not resolve for node ${n.id}`);
    }
  }

  await db.transaction(async (tx) => {
    await tx.insert(schema.planNodes).values(
      ordered.map((n) => ({
        id: n.id,
        repositoryId,
        parentId: n.parentId,
        path: pathById.get(n.id)!,
        ordinal: n.ordinal,
        title: n.title,
        kind: n.kind as 'component',
        body: n.body,
        status: n.status as 'todo',
        taskable: n.taskable,
        createdBy: n.createdBy,
      })),
    );
    const edges = (mirror.edges ?? []).filter(
      (e) => byId.has(e.fromNodeId) && byId.has(e.toNodeId),
    );
    if (edges.length > 0) {
      await tx
        .insert(schema.planNodeEdges)
        .values(
          edges.map((e) => ({
            repositoryId,
            fromNodeId: e.fromNodeId,
            toNodeId: e.toNodeId,
            kind: e.kind as 'affects',
            note: e.note,
          })),
        )
        .onConflictDoNothing();
    }
    if (codeLinks.length > 0) {
      await tx.insert(schema.planNodeCodeLinks).values(
        codeLinks.map((link) => ({
          repositoryId,
          nodeId: link.nodeId,
          repoPath: link.repoPath,
          symbol: link.symbol,
          evidence: link.evidence,
          derivedAtCommit: link.derivedAtCommit,
          stale: link.stale,
          role: link.role,
          confidence: null,
        })),
      );
    }

    // Revisions are a local outbox mechanism, not portable plan state. The
    // imported files and fresh DB begin synchronized at the first local rev.
    const revision = 1;
    await tx
      .insert(schema.planMirrorState)
      .values({
        repositoryId,
        revision,
        writtenRevision: revision,
        writtenAt: new Date(),
        syncedHash: hashBytes(rawText),
      })
      .onConflictDoUpdate({
        target: schema.planMirrorState.repositoryId,
        set: {
          revision,
          writtenRevision: revision,
          lastError: null,
          writtenAt: new Date(),
          updatedAt: new Date(),
          syncedHash: hashBytes(rawText),
        },
      });
  });

  logger.info(
    {
      repositoryId,
      nodes: ordered.length,
      edges: mirror.edges?.length ?? 0,
      codeLinks: codeLinks.length,
      schemaVersion: mirror.schemaVersion,
    },
    'restored plan from .haive-data mirror',
  );
  return { imported: true };
}

/**
 * Reconcile a PULLED plan snapshot onto a plan that already exists.
 *
 * `importPlanMirror` cannot serve this: it refuses whenever the repository has
 * any plan rows, which is the entire case here. This is the second deliberate
 * bypass of `applyPlanPatch`, for the reason the first one documents — node ids
 * are restored VERBATIM, and the patch contract cannot express "create this node
 * with exactly this id". Verbatim ids are also what makes reconciling tractable
 * at all: two Haive instances that both restored from the same committed
 * snapshot are talking about the same nodes.
 *
 * ADDITIVE ONLY, and that is the whole design:
 *   - a node only in the snapshot is CREATED here
 *   - a node in both is UPDATED here
 *   - a node only HERE is KEPT, and reported
 *
 * The third case is where a merge would have to guess. A local-only node is
 * either work someone added and has not pushed, or work the other side deleted,
 * and the snapshot cannot tell those apart. Deleting is the one outcome with no
 * undo, so it is not taken: the caller is handed the ids instead, and a person
 * decides. Same for edges and code links, which are inserted and never removed.
 *
 * One transaction, so a failure leaves the plan exactly as it was.
 */
export async function reconcilePlanMirror(
  db: Database,
  repositoryId: string,
  storagePath: string,
): Promise<PlanPullOutcome> {
  const empty = (skipped: string): PlanPullOutcome => ({
    previousCommit: null,
    fastForwarded: false,
    nodesCreated: 0,
    nodesUpdated: 0,
    keptLocal: [],
    edgesAdded: 0,
    codeLinksAdded: 0,
    skipped,
  });

  let rawPayload: unknown;
  let rawText: string;
  try {
    const raw = await readTextNoFollow(storagePath, HAIVE_DATA_FILES.plan);
    if (raw === null) return empty('this repository has no committed plan snapshot');
    rawText = raw;
    rawPayload = JSON.parse(raw) as unknown;
  } catch {
    return empty('this repository has no committed plan snapshot');
  }

  const parsed = planMirrorPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(
      `the committed plan snapshot could not be read: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    );
  }
  const mirror = parsed.data;
  const incoming =
    mirror.schemaVersion === 1
      ? mirror.nodes.map((n) => ({ ...n, createdBy: n.createdBy }))
      : mirror.nodes.map((n) => ({ ...n, createdBy: 'import' as const }));
  if (incoming.length === 0) return empty('the committed plan snapshot has no nodes');

  const byId = new Map(incoming.map((n) => [n.id, n]));
  for (const n of incoming) {
    if (n.parentId !== null && !byId.has(n.parentId)) {
      throw new Error(`the committed plan snapshot references a missing parent (${n.parentId})`);
    }
  }
  const codeLinks = mirror.schemaVersion === 2 ? mirror.codeLinks : [];

  return db.transaction(async (tx) => {
    // Serialized against every mirror WRITE on the same repository: a reconcile
    // that raced a flush could otherwise import a file the flush is mid-rename.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`);
    // A flush that held the lock first may have replaced the file this read; stamping the older
    // bytes would make the next flush hold on a file Haive wrote.
    if ((await readTextNoFollow(storagePath, HAIVE_DATA_FILES.plan)) !== rawText) {
      throw new Error('the plan snapshot changed while it was being read; try again');
    }

    const localRows = await tx
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repositoryId));
    const localIds = new Set(localRows.map((r) => r.id));

    // A node id is globally unique, so an incoming id that exists under ANOTHER
    // repository is not this plan's node. Refuse whole rather than import half.
    const foreignIds = incoming.map((n) => n.id).filter((id) => !localIds.has(id));
    if (foreignIds.length > 0) {
      const clash = await tx
        .select({ id: schema.planNodes.id })
        .from(schema.planNodes)
        .where(inArray(schema.planNodes.id, foreignIds))
        .limit(1);
      if (clash.length > 0) {
        throw new Error('the incoming plan contains nodes that belong to another repository');
      }
    }

    // Parents before children, so a created node's `path` can be built from one
    // that is already placed. `place()`'s cycle guard is what stops a snapshot
    // whose parentage loops from hanging this.
    const pathById = new Map<string, string>();
    const ordered: typeof incoming = [];
    const resolving = new Set<string>();
    const place = (id: string): boolean => {
      if (pathById.has(id)) return true;
      if (resolving.has(id)) return false;
      const node = byId.get(id);
      if (!node) return false;
      resolving.add(id);
      let parentPath: string | null = null;
      if (node.parentId !== null) {
        if (!place(node.parentId)) {
          resolving.delete(id);
          return false;
        }
        parentPath = pathById.get(node.parentId)!;
      }
      resolving.delete(id);
      pathById.set(id, planNodePath(parentPath, id));
      ordered.push(node);
      return true;
    };
    for (const n of incoming) {
      if (!place(n.id)) {
        throw new Error(`the incoming plan's parentage does not resolve for node ${n.id}`);
      }
    }

    let nodesCreated = 0;
    let nodesUpdated = 0;
    for (const node of ordered) {
      const fields = {
        parentId: node.parentId,
        path: pathById.get(node.id)!,
        ordinal: node.ordinal,
        title: node.title,
        kind: node.kind as 'component',
        body: node.body,
        status: node.status as 'todo',
        taskable: node.taskable,
        updatedAt: new Date(),
      };
      if (localIds.has(node.id)) {
        await tx
          .update(schema.planNodes)
          .set({ ...fields, version: sql`${schema.planNodes.version} + 1` })
          .where(eq(schema.planNodes.id, node.id));
        nodesUpdated++;
      } else {
        await tx
          .insert(schema.planNodes)
          .values({ id: node.id, repositoryId, createdBy: node.createdBy, ...fields });
        nodesCreated++;
      }
    }

    // A node kept locally may still sit under a parent the snapshot MOVED, so its
    // stored ancestry is now wrong. Rebuild every path from parentage rather than
    // patching the ones that look affected — the whole plan is a few thousand
    // short strings and a wrong `path` is invisible to every read that depends on
    // it.
    const keptLocal = [...localIds].filter((id) => !byId.has(id));
    if (keptLocal.length > 0) {
      const all = await tx
        .select({ id: schema.planNodes.id, parentId: schema.planNodes.parentId })
        .from(schema.planNodes)
        .where(eq(schema.planNodes.repositoryId, repositoryId));
      const parentOf = new Map(all.map((r) => [r.id, r.parentId]));
      const resolved = new Map<string, string>();
      const walk = (id: string, seen: Set<string>): string | null => {
        const cached = resolved.get(id);
        if (cached) return cached;
        if (seen.has(id)) return null;
        seen.add(id);
        const parentId = parentOf.get(id) ?? null;
        let parentPath: string | null = null;
        if (parentId !== null) {
          parentPath = walk(parentId, seen);
          if (parentPath === null) return null;
        }
        const own = planNodePath(parentPath, id);
        resolved.set(id, own);
        return own;
      };
      for (const row of all) {
        const own = walk(row.id, new Set());
        if (own)
          await tx
            .update(schema.planNodes)
            .set({ path: own })
            .where(eq(schema.planNodes.id, row.id));
      }
    }

    // Edges and code links are INSERTED, never removed, for the same reason a
    // local-only node is kept: a link that is here and not in the snapshot may be
    // one someone added, and dropping it is not reversible.
    const liveIds = new Set([...localIds, ...byId.keys()]);
    const edges = (mirror.edges ?? []).filter(
      (e) => liveIds.has(e.fromNodeId) && liveIds.has(e.toNodeId) && e.fromNodeId !== e.toNodeId,
    );
    let edgesAdded = 0;
    if (edges.length > 0) {
      const inserted = await tx
        .insert(schema.planNodeEdges)
        .values(
          edges.map((e) => ({
            repositoryId,
            fromNodeId: e.fromNodeId,
            toNodeId: e.toNodeId,
            kind: e.kind as 'affects',
            note: e.note,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.planNodeEdges.id });
      edgesAdded = inserted.length;
    }

    const links = codeLinks.filter((l) => liveIds.has(l.nodeId));
    let codeLinksAdded = 0;
    if (links.length > 0) {
      const inserted = await tx
        .insert(schema.planNodeCodeLinks)
        .values(
          links.map((l) => ({
            repositoryId,
            nodeId: l.nodeId,
            repoPath: l.repoPath,
            symbol: l.symbol,
            evidence: l.evidence,
            derivedAtCommit: l.derivedAtCommit,
            stale: l.stale,
            role: l.role,
            confidence: null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.planNodeCodeLinks.id });
      codeLinksAdded = inserted.length;
    }

    // Dirty, not clean: the local-only nodes this kept mean the database now says
    // something the pulled file does not, so the file has to be rewritten from
    // the database rather than trusted as current.
    if (nodesCreated > 0 || nodesUpdated > 0 || keptLocal.length > 0) {
      await markPlanMirrorDirty(tx, repositoryId);
    }
    await tx
      .insert(schema.planMirrorState)
      .values({ repositoryId, revision: 0, writtenRevision: 0, syncedHash: hashBytes(rawText) })
      .onConflictDoUpdate({
        target: schema.planMirrorState.repositoryId,
        set: { syncedHash: hashBytes(rawText) },
      });

    logger.info(
      { repositoryId, nodesCreated, nodesUpdated, keptLocal: keptLocal.length, edgesAdded },
      'reconciled plan from pulled .haive-data mirror',
    );
    return {
      previousCommit: null,
      fastForwarded: false,
      nodesCreated,
      nodesUpdated,
      keptLocal,
      edgesAdded,
      codeLinksAdded,
      skipped: null,
    } satisfies PlanPullOutcome;
  });
}

/** Resolve the repository's writable/readable checkout and flush its current
 *  portable model. Used by both one-off queue jobs and the dirty-row sweep. */
export async function flushPlanMirrorForRepository(
  db: Database,
  repositoryId: string,
): Promise<{ files: string[]; repoPath: string }> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  if (!repoPath) throw new Error('repository has no resolvable filesystem path');
  const files = await writePlanMirror(db, repositoryId, repoPath);
  return { files, repoPath };
}

/** Stamps every clean row that has no `synced_hash` yet and whose plan.json already is what the
 *  database renders. A row whose file differs stays unstamped, and its next flush adopts the file
 *  as it did before the guard existed. */
export async function stampPlanMirrorHashesAtBoot(db: Database): Promise<number> {
  const rows = await db
    .select({ repositoryId: schema.planMirrorState.repositoryId })
    .from(schema.planMirrorState)
    .where(
      and(
        isNull(schema.planMirrorState.syncedHash),
        gte(schema.planMirrorState.writtenRevision, schema.planMirrorState.revision),
      ),
    );
  let stamped = 0;
  for (const { repositoryId } of rows) {
    try {
      const done = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`);
        const [state] = await tx
          .select({ syncedHash: schema.planMirrorState.syncedHash })
          .from(schema.planMirrorState)
          .where(eq(schema.planMirrorState.repositoryId, repositoryId))
          .limit(1);
        if (!state || state.syncedHash !== null) return false;
        const [repo] = await tx
          .select({
            storagePath: schema.repositories.storagePath,
            localPath: schema.repositories.localPath,
          })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .limit(1);
        const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
        if (!repoPath) return false;
        const rendered = await renderPlanMirrorFiles(tx, repositoryId);
        const onDisk = await readTextNoFollow(repoPath, HAIVE_DATA_FILES.plan);
        const matches =
          rendered === null ? onDisk === null : onDisk !== null && onDisk === rendered.json;
        if (!matches) return false;
        await stampSyncedHash(tx, repositoryId, hashBytes(onDisk ?? ''));
        return true;
      });
      if (done) stamped++;
    } catch (err) {
      logger.warn({ err, repositoryId }, 'plan mirror hash not stamped at boot');
    }
  }
  return stamped;
}

export async function recordPlanMirrorError(
  db: Database,
  repositoryId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .insert(schema.planMirrorState)
    .values({
      repositoryId,
      revision: 0,
      writtenRevision: 0,
      lastError: message.slice(0, 4_000),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.planMirrorState.repositoryId,
      set: { lastError: message.slice(0, 4_000), updatedAt: new Date() },
    });
}
