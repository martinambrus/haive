import { planMirrorErrorsSuppressed } from './error-scope.js';
import { lockRepositoryTasksKey } from '@haive/database';
import { checkoutMatches, checkoutMissing, type NamedCheckout } from '../repo/checkout-head.js';
import { admitWatchedCheckout } from '../project-state/watch-admission.js';
import { scrubErrorPaths } from '@haive/shared/logger';
import { createHash } from 'node:crypto';
import {
  readFileNoFollow,
  removeNoFollow,
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { and, eq, gte, inArray, isNull, like, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  HAIVE_DATA_FILES,
  PLAN_MIRROR_SCHEMA_VERSION,
  logger,
  type PlanMirror,
  type PlanMirrorPayload,
  type PlanPullOutcome,
} from '@haive/shared';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import {
  loadPlanEdges,
  loadPlanNodes,
  markPlanMirrorDirty,
  renderPlanMarkdownFrom,
  planNodePath,
  serializePlanMirror,
} from '@haive/shared/plan';
import {
  PLAN_MIRROR_ASKED_FIELDS,
  mergePlanMirror,
  type PlanMirrorConflict,
} from '@haive/shared/plan-mirror-merge';
import {
  PLAN_UNIT_PREFIX,
  conflictSide,
  conflictSideValue,
  parsePlanConflictUnit,
  planConflictUnit,
  sameValue,
} from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
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
  constructor(
    message: string,
    readonly code:
      | 'plan_mirror_held'
      | 'git_operation'
      | 'checkout_missing'
      | 'checkout_changed' = 'plan_mirror_held',
  ) {
    super(message);
  }
}

// A plan this size is far past any real plan; a larger file is held rather than buffered.
export const PLAN_JSON_MAX_BYTES = 16 * 1024 * 1024;
const PLAN_WRITE_TOO_LARGE = `the plan renders to more than ${PLAN_JSON_MAX_BYTES / 1024 / 1024} MiB, so its plan.json is not written; nothing was written.`;
const PLAN_TOO_LARGE = `the committed plan snapshot is larger than ${PLAN_JSON_MAX_BYTES / 1024 / 1024} MiB`;

/** plan.json's bytes, `'too-large'` past the cap (nothing beyond it is read), or null when absent. */
async function readPlanJson(anchor: string): Promise<Buffer | 'too-large' | null> {
  const read = await readFileNoFollow(anchor, HAIVE_DATA_FILES.plan, {
    maxBytes: PLAN_JSON_MAX_BYTES,
  });
  if (read === null) return null;
  return read.truncated ? 'too-large' : read.data;
}

const hashBytes = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

// Stamped when the files were removed, so a plan.json that arrives later reads as unimported.
const ABSENT_HASH = 'absent';

const HELD_GIT_OPERATION =
  'a merge, rebase, cherry-pick or revert is open in the checkout; nothing was written. The plan is written again once it finishes.';
const HELD_NO_CHECKOUT =
  "the repository's checkout directory is missing; nothing was written. The plan is written again once it is back.";
const HELD_NO_BASE =
  "the checkout's plan.json holds changes Haive has not read in, and this plan has unwritten changes of its own with no earlier copy to tell them apart; Pull the plan to bring them in. Nothing was written.";
const HELD_RACED =
  "the plan was edited while the checkout's plan.json was being merged in; nothing was merged. It is merged again on the next pass.";
const HELD_MOVED =
  "the checkout's plan.json changed while the plan was being written; nothing was written. It is written again on the next pass.";
const heldUnreadable = (reason: string): string =>
  `the checkout's plan.json could not be read in (${reason}); fix or discard it, then Pull the plan. Nothing was written.`;

type PlanMirrorTx = Parameters<Parameters<Database['transaction']>[0]>[0];

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

export const lockPlanMirror = (db: Pick<Database, 'execute'>, repositoryId: string) =>
  db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`);

type PlanQuestion = {
  nodeId: string;
  field: string;
  row: typeof schema.projectStateConflicts.$inferSelect;
};

async function loadPendingPlanQuestions(
  db: Pick<Database, 'select'>,
  repositoryId: string,
): Promise<PlanQuestion[]> {
  const rows = await db
    .select()
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        like(schema.projectStateConflicts.unit, `${PLAN_UNIT_PREFIX}%`),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
  const out: PlanQuestion[] = [];
  for (const row of rows) {
    const parsed = parsePlanConflictUnit(row.unit);
    if (parsed) out.push({ ...parsed, row });
  }
  return out;
}

/** The plan in the database as the mirror holds it, with no question applied. */
async function renderPlanMirror(
  db: PlanMirrorTx,
  repositoryId: string,
): Promise<{
  mirror: PlanMirror;
  nodes: Awaited<ReturnType<typeof loadPlanNodes>>;
  edges: Awaited<ReturnType<typeof loadPlanEdges>>;
} | null> {
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
  return { mirror, nodes, edges };
}

/** The two files as the flush writes them now, or null when there is no plan. A field with a
 *  pending question carries the checkout's value in plan.json; the database keeps its own. */
async function renderPlanMirrorFiles(
  db: PlanMirrorTx,
  repositoryId: string,
): Promise<{ json: string; markdown: string } | null> {
  const rendered = await renderPlanMirror(db, repositoryId);
  if (!rendered) return null;
  const questions = await loadPendingPlanQuestions(db, repositoryId);
  const incoming = new Map<string, unknown>();
  for (const q of questions) {
    const side = conflictSideValue(q.row.incoming);
    if (side !== undefined) incoming.set(`${q.nodeId}\0${q.field}`, side);
  }
  const mirror: PlanMirror =
    incoming.size === 0
      ? rendered.mirror
      : {
          ...rendered.mirror,
          nodes: rendered.mirror.nodes.map((n) => {
            const patched: Record<string, unknown> = { ...n };
            for (const field of PLAN_MIRROR_ASKED_FIELDS) {
              const key = `${n.id}\0${field}`;
              if (incoming.has(key)) patched[field] = incoming.get(key);
            }
            return patched as PlanMirror['nodes'][number];
          }),
        };
  return {
    json: serializePlanMirror(mirror),
    markdown: renderPlanMarkdownFrom(rendered.nodes, rendered.edges),
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
      await lockPlanMirror(tx, repositoryId);
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

const loadMirrorState = async (db: PlanMirrorTx, repositoryId: string) => {
  const columns = {
    revision: schema.planMirrorState.revision,
    writtenRevision: schema.planMirrorState.writtenRevision,
    syncedHash: schema.planMirrorState.syncedHash,
    hasBase: sql<boolean>`${schema.planMirrorState.syncedSnapshot} is not null`,
  };
  const [state] = await db
    .select(columns)
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  return state ?? null;
};

/** Removes plan.json only while it still holds the bytes this flush judged, decided on the file removed. */
export async function removePlanJsonIfUnchanged(
  repoPath: string,
  judged: Buffer | null,
): Promise<void> {
  let operation = false;
  const outcome = await removeFileIfNoFollow(
    repoPath,
    HAIVE_DATA_FILES.plan,
    async (data) => {
      operation = await gitOperationInProgress(repoPath);
      return !operation && judged !== null && data.equals(judged);
    },
    { maxBytes: PLAN_JSON_MAX_BYTES },
  );
  if (outcome === 'kept') {
    throw new PlanMirrorHeldError(
      operation ? HELD_GIT_OPERATION : HELD_MOVED,
      operation ? 'git_operation' : 'checkout_changed',
    );
  }
  if (outcome === 'absent' && (await gitOperationInProgress(repoPath))) {
    throw new PlanMirrorHeldError(HELD_GIT_OPERATION, 'git_operation');
  }
}

/** Replaces plan.json only while it still holds the bytes this flush judged (or already holds the
 *  render), deciding on the file it holds, so bytes a pull lands meanwhile are never written over. */
export async function writePlanJsonIfUnchanged(
  repoPath: string,
  json: string,
  judged: Buffer | null,
): Promise<void> {
  const bytes = Buffer.from(json, 'utf8');
  // Every read of plan.json stops at the cap, so a larger file Haive wrote could never be judged again.
  if (bytes.length > PLAN_JSON_MAX_BYTES) throw new PlanMirrorHeldError(PLAN_WRITE_TOO_LARGE);
  let operation = false;
  // The merge check is repeated here, after the file is parked, so it sits next to the replace.
  const outcome = await rewriteFileIfNoFollow(
    repoPath,
    HAIVE_DATA_FILES.plan,
    async (data) => {
      operation = await gitOperationInProgress(repoPath);
      if (operation) return null;
      return (judged !== null && data.equals(judged)) || data.equals(bytes) ? bytes : null;
    },
    { maxBytes: PLAN_JSON_MAX_BYTES },
  );
  if (outcome === 'kept') {
    throw new PlanMirrorHeldError(
      operation ? HELD_GIT_OPERATION : HELD_MOVED,
      operation ? 'git_operation' : 'checkout_changed',
    );
  }
  if (outcome === 'rewritten') return;
  if (await gitOperationInProgress(repoPath))
    throw new PlanMirrorHeldError(HELD_GIT_OPERATION, 'git_operation');
  try {
    await writeFileNoFollow(repoPath, HAIVE_DATA_FILES.plan, bytes, {
      mode: 'create-exclusive',
      createParents: true,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
    throw err;
  }
}

async function writePlanMirrorLocked(
  db: PlanMirrorTx,
  repositoryId: string,
  repoPath: string,
  changes?: PlanMirrorChanges,
): Promise<{ written: string[]; failed?: unknown }> {
  let state = await loadMirrorState(db, repositoryId);
  if (!state) {
    await db
      .insert(schema.planMirrorState)
      .values({ repositoryId, revision: 1, writtenRevision: 0 })
      .onConflictDoNothing();
    state = await loadMirrorState(db, repositoryId);
  }

  if (await gitOperationInProgress(repoPath))
    throw new PlanMirrorHeldError(HELD_GIT_OPERATION, 'git_operation');
  let rendered = await renderPlanMirrorFiles(db, repositoryId);
  const onDiskRead = await readPlanJson(repoPath);
  if (onDiskRead === 'too-large') throw new PlanMirrorHeldError(heldUnreadable(PLAN_TOO_LARGE));
  const onDiskBytes = onDiskRead;
  if (onDiskBytes !== null) {
    const diskHash = hashBytes(onDiskBytes);
    // Haive never writes an empty plan.json; older rows stamped absence as the hash of zero bytes.
    const synced = onDiskBytes.length > 0 && diskHash === (state?.syncedHash ?? null);
    // A row stamped before 0196 has no base; the bytes it last read or wrote are it, so they are
    // stored before this flush writes its own edits over them.
    if (synced && state && !state.hasBase) await seedBaseFrom(db, repositoryId, onDiskBytes);
    if (!synced && rendered !== null && diskHash === hashBytes(rendered.json)) {
      // The checkout reached this plan on its own: what both hold is agreed, so it is the base.
      const agreed = planMirrorPayloadSchema.safeParse(JSON.parse(rendered.json) as unknown);
      if (agreed.success) await storeAgreedBase(db, repositoryId, agreed.data);
    }
    if (!synced && !(rendered !== null && diskHash === hashBytes(rendered.json))) {
      if (state?.syncedHash == null) {
        logger.warn(
          { repoPath },
          'plan.json differs from the database and was never stamped; adopting',
        );
      } else if (!state.hasBase && state.revision > state.writtenRevision) {
        throw new PlanMirrorHeldError(HELD_NO_BASE);
      } else {
        const outcome = await reconcilePlanLocked(db, repositoryId, onDiskBytes, {}).catch(
          (err) => {
            if (err instanceof PlanSnapshotError)
              throw new PlanMirrorHeldError(heldUnreadable(err.message));
            throw err;
          },
        );
        if (outcome.skipped) throw new PlanMirrorHeldError(heldUnreadable(outcome.skipped));
        state = await loadMirrorState(db, repositoryId);
        rendered = await renderPlanMirrorFiles(db, repositoryId);
      }
    }
  }
  await convergePlanQuestions(db, repositoryId);
  const targetRevision = Math.max(1, state?.revision ?? 1);

  if (!rendered) {
    await removePlanJsonIfUnchanged(repoPath, onDiskBytes);
    changes?.removed.push(HAIVE_DATA_FILES.plan);
    await db
      .update(schema.planMirrorState)
      .set({ syncedHash: ABSENT_HASH, syncedSnapshot: null })
      .where(eq(schema.planMirrorState.repositoryId, repositoryId));
    await closePlanQuestions(db, repositoryId, new Set());
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

  await writePlanJsonIfUnchanged(repoPath, rendered.json, onDiskBytes);
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
  expectedCheckout?: NamedCheckout,
): Promise<PlanMirrorImport> {
  let rawPayload: unknown;
  let rawBytes: Buffer;
  try {
    // null is absence OR a refusal — a link, a non-regular file — and both mean there is no mirror
    // to import, which is exactly what the `catch` concluded for an unreadable path.
    const raw = await readPlanJson(storagePath);
    if (raw === null) return { imported: false, code: 'no_mirror', reason: 'no plan mirror' };
    if (raw === 'too-large') return refused(PLAN_TOO_LARGE);
    rawBytes = raw;
    rawPayload = JSON.parse(raw.toString('utf8')) as unknown;
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
    if (expectedCheckout) {
      await lockRepositoryTasksKey(tx, repositoryId);
      await lockPlanMirror(tx, repositoryId);
      if (!(await admitWatchedCheckout(tx, repositoryId, storagePath, expectedCheckout)))
        throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
    }
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
        syncedHash: hashBytes(rawBytes),
        syncedSnapshot: mirror,
      })
      .onConflictDoUpdate({
        target: schema.planMirrorState.repositoryId,
        set: {
          revision,
          writtenRevision: revision,
          lastError: null,
          writtenAt: new Date(),
          updatedAt: new Date(),
          syncedHash: hashBytes(rawBytes),
          syncedSnapshot: mirror,
        },
      });
    await assertCheckoutStillHolds(storagePath, rawBytes, expectedCheckout);
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

/** A plan.json that cannot be read in as a plan. The flush holds on it; a Pull reports it. */
class PlanSnapshotError extends Error {
  override readonly name = 'PlanSnapshotError';
}

const NODE_FIELDS = ['parentId', 'ordinal', 'title', 'kind', 'body', 'status', 'taskable'] as const;

const EMPTY_PLAN: PlanMirror = { schemaVersion: 2, nodes: [], edges: [], codeLinks: [] };

const noOutcome = (skipped: string | null): PlanPullOutcome => ({
  previousCommit: null,
  fastForwarded: false,
  nodesCreated: 0,
  nodesUpdated: 0,
  keptLocal: [],
  edgesAdded: 0,
  codeLinksAdded: 0,
  skipped,
});

const NO_SNAPSHOT = 'this repository has no committed plan snapshot';

/** Three-way reconcile of the checkout's plan.json onto the database (docs/architecture/plan-canvas.md);
 *  a deliberate bypass of `applyPlanPatch`, which cannot create a node with a chosen id. */
export async function reconcilePlanFromCheckout(
  db: Database,
  repositoryId: string,
  repoPath: string,
  opts: { requireStamp?: boolean; expectedCheckout?: NamedCheckout } = {},
): Promise<PlanPullOutcome> {
  if (await gitOperationInProgress(repoPath))
    throw new PlanMirrorHeldError(HELD_GIT_OPERATION, 'git_operation');
  return db.transaction(async (tx) => {
    if (opts.expectedCheckout) await lockRepositoryTasksKey(tx, repositoryId);
    await lockPlanMirror(tx, repositoryId);
    if (
      opts.expectedCheckout &&
      !(await admitWatchedCheckout(tx, repositoryId, repoPath, opts.expectedCheckout))
    )
      throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
    let bytes: Buffer | null;
    try {
      const read = await readPlanJson(repoPath);
      if (read === 'too-large') return noOutcome(PLAN_TOO_LARGE);
      bytes = read;
    } catch {
      bytes = null;
    }
    if (bytes === null) return noOutcome(NO_SNAPSHOT);
    const outcome = await reconcilePlanLocked(tx, repositoryId, bytes, opts);
    await assertCheckoutStillHolds(repoPath, bytes, opts.expectedCheckout);
    return outcome;
  });
}

/** The lock does not hold git off the checkout: what was read must still be there, and no merge,
 *  rebase, cherry-pick or revert may have opened since, or the bytes read in may be ones an abort
 *  takes back. */
async function assertCheckoutStillHolds(
  repoPath: string,
  bytes: Buffer,
  expectedCheckout?: NamedCheckout,
): Promise<void> {
  if (expectedCheckout && !(await checkoutMatches(repoPath, expectedCheckout)))
    throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
  if (await gitOperationInProgress(repoPath))
    throw new PlanMirrorHeldError(HELD_GIT_OPERATION, 'git_operation');
  const now = await readPlanJson(repoPath);
  if (!Buffer.isBuffer(now) || !now.equals(bytes))
    throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
  if (expectedCheckout && !(await checkoutMatches(repoPath, expectedCheckout)))
    throw new PlanMirrorHeldError(HELD_MOVED, 'checkout_changed');
}

const UNRELATED_ROOT =
  'the committed plan has a different root from this plan, so the two share no history and were not merged';

/** After a push, what was pushed is what the other side will read next, so it becomes the base;
 *  a field still asked about keeps its old base so the question stands. */
export async function advancePlanBaseToPushed(
  db: Database,
  repositoryId: string,
  pushedJson: string,
  stillShared: () => Promise<boolean> = async () => true,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(pushedJson) as unknown;
  } catch {
    return;
  }
  const parsed = planMirrorPayloadSchema.safeParse(raw);
  if (!parsed.success) return;
  await db.transaction(async (tx) => {
    await lockPlanMirror(tx, repositoryId);
    // Two Saves can finish out of order; only the push that is still the remote tip moves the base.
    if (!(await stillShared())) return;
    await storeAgreedBase(tx, repositoryId, parsed.data);
  });
}

async function seedBaseFrom(tx: PlanMirrorTx, repositoryId: string, bytes: Buffer): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return;
  }
  const parsed = planMirrorPayloadSchema.safeParse(raw);
  if (parsed.success) await storeAgreedBase(tx, repositoryId, parsed.data);
}

/** A node both sides added with an asked field set differently had no base: it stays out of the
 *  next one, with whatever new subtree hangs under it, so the question is asked again. An old base
 *  node moved under it keeps its old base entry, ancestry included. */
function withoutAbsentAsked(
  payload: PlanMirrorPayload,
  absent: ReadonlySet<string>,
  oldBase: ReadonlyMap<string, PlanMirrorPayload['nodes'][number]>,
): PlanMirrorPayload {
  if (absent.size === 0) return payload;
  const children = new Map<string, string[]>();
  for (const n of payload.nodes) {
    if (n.parentId !== null) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  }
  const drop = new Set<string>();
  for (const id of absent) {
    const subtree: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.pop()!;
      subtree.push(next);
      queue.push(...(children.get(next) ?? []));
    }
    for (const n of subtree) if (!oldBase.has(n)) drop.add(n);
  }
  if (drop.size === 0) return payload;
  const nodes = payload.nodes
    .filter((n) => !drop.has(n.id))
    .map((n) => (n.parentId !== null && drop.has(n.parentId) ? oldBase.get(n.id)! : n));
  // A restored node's old ancestors come back too, where the other side has since deleted them.
  const present = new Set(nodes.map((n) => n.id));
  for (let i = 0; i < nodes.length; i++) {
    const parentId = nodes[i]!.parentId;
    const parent = parentId === null || present.has(parentId) ? undefined : oldBase.get(parentId);
    if (parent) {
      nodes.push(parent);
      present.add(parent.id);
    }
  }
  return {
    ...payload,
    nodes,
    edges: payload.edges.filter((e) => !drop.has(e.fromNodeId) && !drop.has(e.toNodeId)),
    ...('codeLinks' in payload
      ? { codeLinks: payload.codeLinks.filter((l) => !drop.has(l.nodeId)) }
      : {}),
  } as PlanMirrorPayload;
}

/** Both sides hold `agreed`, so it becomes the base; a field still asked about keeps its old base. */
async function storeAgreedBase(
  tx: PlanMirrorTx,
  repositoryId: string,
  agreed: PlanMirrorPayload,
): Promise<void> {
  const [state] = await tx
    .select({ syncedSnapshot: schema.planMirrorState.syncedSnapshot })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  if (!state) return;
  const old = planMirrorPayloadSchema.safeParse(state.syncedSnapshot);
  const oldById = new Map(old.success ? old.data.nodes.map((n) => [n.id, n]) : []);
  const asked = await loadPendingPlanQuestions(tx, repositoryId);
  const unbased = new Set(asked.filter((q) => !oldById.has(q.nodeId)).map((q) => q.nodeId));
  const snapshot = withoutAbsentAsked(
    asked.length === 0
      ? agreed
      : ({
          ...agreed,
          nodes: agreed.nodes.map((n) => {
            const patched: Record<string, unknown> = { ...n };
            const before = oldById.get(n.id) as Record<string, unknown> | undefined;
            for (const q of asked) {
              if (q.nodeId === n.id && before) patched[q.field] = before[q.field];
            }
            return patched;
          }),
        } as PlanMirrorPayload),
    unbased,
    oldById as ReadonlyMap<string, PlanMirrorPayload['nodes'][number]>,
  );
  await tx
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: snapshot })
    .where(eq(schema.planMirrorState.repositoryId, repositoryId));
}

/** Run after a push with the commit read before it: the push carried at least that commit, so its
 *  plan.json is shared. The push already landed, so a base left behind is only logged. */
export async function advancePlanBaseFromCommit(
  db: Database,
  repositoryId: string,
  repoPath: string,
  commit: string | null,
  branch: string,
): Promise<void> {
  if (!commit) return;
  try {
    const pushed = await gitRun(repoPath, ['show', `${commit}:${HAIVE_DATA_FILES.plan}`]);
    if (pushed.code !== 0) return;
    // Shared once the remote holds it; current only while the tip still carries its plan.json,
    // so a slower Save never moves the base back over a later push.
    const remote = `refs/remotes/origin/${branch}`;
    await advancePlanBaseToPushed(db, repositoryId, pushed.stdout, async () => {
      const held = await gitRun(repoPath, ['merge-base', '--is-ancestor', commit, remote]);
      if (held.code !== 0) return false;
      const atTip = await gitRun(repoPath, ['show', `${remote}:${HAIVE_DATA_FILES.plan}`]);
      return atTip.code === 0 && atTip.stdout === pushed.stdout;
    });
  } catch (err) {
    logger.warn({ err, repositoryId }, 'plan base not advanced after push');
  }
}

/** A pending question settles once its node is gone, or once this plan holds the field at the
 *  incoming value; the base then takes that value, since both sides now agree on it. */
async function convergePlanQuestions(tx: PlanMirrorTx, repositoryId: string): Promise<void> {
  const asked = await loadPendingPlanQuestions(tx, repositoryId);
  if (asked.length === 0) return;
  // Locked before the render, so a canvas edit cannot land between the judgement and the close.
  await tx
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(
      inArray(
        schema.planNodes.id,
        asked.map((q) => q.nodeId),
      ),
    )
    .for('update');
  const local = (await renderPlanMirror(tx, repositoryId))?.mirror;
  const byId = new Map((local?.nodes ?? []).map((n) => [n.id, n as Record<string, unknown>]));
  const agreed = new Map<string, unknown>();
  for (const q of asked) {
    const node = byId.get(q.nodeId);
    if (node && !sameValue(conflictSide(node[q.field]), q.row.incoming)) {
      // Still asked, but this side may have moved to a third value: the question shows the current one.
      const local = conflictSide(node[q.field]);
      if (!sameValue(local, q.row.local)) {
        await tx
          .update(schema.projectStateConflicts)
          .set({ local })
          .where(eq(schema.projectStateConflicts.id, q.row.id));
      }
      continue;
    }
    if (node) agreed.set(`${q.nodeId}\0${q.field}`, node[q.field]);
    await tx
      .update(schema.projectStateConflicts)
      .set({ resolution: 'converged', resolvedAt: new Date() })
      .where(eq(schema.projectStateConflicts.id, q.row.id));
  }
  if (agreed.size === 0) return;
  const [state] = await tx
    .select({ syncedSnapshot: schema.planMirrorState.syncedSnapshot })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  const base = planMirrorPayloadSchema.safeParse(state?.syncedSnapshot);
  if (!base.success) return;
  // A node both sides added stays out even when settled: only the asked field is known to be shared,
  // and taking this side's copy would make an unpushed edit or child read as shared.
  const snapshot = {
    ...base.data,
    nodes: base.data.nodes.map((n) => {
      const patched: Record<string, unknown> = { ...n };
      for (const field of PLAN_MIRROR_ASKED_FIELDS) {
        const key = `${n.id}\0${field}`;
        if (agreed.has(key)) patched[field] = agreed.get(key);
      }
      return patched;
    }),
  } as PlanMirrorPayload;
  await tx
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: snapshot })
    .where(eq(schema.planMirrorState.repositoryId, repositoryId));
}

/** `bytes` is the plan.json read under the plan-mirror lock the caller holds; the stamp is its hash. */
async function reconcilePlanLocked(
  tx: PlanMirrorTx,
  repositoryId: string,
  bytes: Buffer,
  opts: { requireStamp?: boolean },
): Promise<PlanPullOutcome> {
  const [state] = await tx
    .select({
      syncedHash: schema.planMirrorState.syncedHash,
      syncedSnapshot: schema.planMirrorState.syncedSnapshot,
    })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  const hash = hashBytes(bytes);
  if (bytes.length > 0 && state?.syncedHash === hash) {
    // A row stamped before 0196 has the bytes it last read but no base; they are the base.
    if (state.syncedSnapshot == null) await seedBaseFrom(tx, repositoryId, bytes);
    await convergePlanQuestions(tx, repositoryId);
    return noOutcome(null);
  }
  const raw = bytes.toString('utf8');
  if (opts.requireStamp && !state?.syncedHash) return noOutcome(null);
  // A rescan cannot ask: with no base, incoming would win over edits not yet written out.
  if (opts.requireStamp && state?.syncedSnapshot == null) {
    const [dirty] = await tx
      .select({ id: schema.planMirrorState.repositoryId })
      .from(schema.planMirrorState)
      .where(
        and(
          eq(schema.planMirrorState.repositoryId, repositoryId),
          sql`${schema.planMirrorState.revision} > ${schema.planMirrorState.writtenRevision}`,
        ),
      )
      .limit(1);
    if (dirty) throw new PlanMirrorHeldError(HELD_NO_BASE);
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(raw) as unknown;
  } catch {
    throw new PlanSnapshotError('the committed plan snapshot is not valid JSON');
  }
  const parsed = planMirrorPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new PlanSnapshotError(
      `the committed plan snapshot could not be read: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    );
  }
  const incoming: PlanMirrorPayload = parsed.data;
  if (incoming.nodes.length === 0) return noOutcome('the committed plan snapshot has no nodes');

  const incomingIds = new Set(incoming.nodes.map((n) => n.id));
  if (incomingIds.size !== incoming.nodes.length) {
    throw new PlanSnapshotError('the committed plan snapshot contains duplicate node refs');
  }
  for (const n of incoming.nodes) {
    if (n.parentId !== null && !incomingIds.has(n.parentId)) {
      throw new PlanSnapshotError(
        `the committed plan snapshot references a missing parent (${n.parentId})`,
      );
    }
  }

  // Read before the render: every write below is fenced on these, so an edit committed after
  // this point makes the reconcile hold instead of overwriting it.
  const versionOf = new Map(
    (
      await tx
        .select({ id: schema.planNodes.id, version: schema.planNodes.version })
        .from(schema.planNodes)
        .where(eq(schema.planNodes.repositoryId, repositoryId))
    ).map((r) => [r.id, r.version]),
  );
  const localRender = await renderPlanMirror(tx, repositoryId);
  const local = localRender?.mirror ?? EMPTY_PLAN;
  const baseParsed = planMirrorPayloadSchema.safeParse(state?.syncedSnapshot);
  // This plan's root, or with no plan here the base's: a plan with another root shares no history.
  const knownRoot =
    local.nodes.find((n) => n.parentId === null) ??
    (baseParsed.success ? baseParsed.data.nodes.find((n) => n.parentId === null) : undefined);
  const incomingRoot = incoming.nodes.find((n) => n.parentId === null);
  if (knownRoot && incomingRoot?.id !== knownRoot.id) throw new PlanSnapshotError(UNRELATED_ROOT);
  const merge = mergePlanMirror({
    base: baseParsed.success ? baseParsed.data : null,
    local,
    incoming,
  });
  const merged = merge.merged;
  if (merged.nodes.length > 0 && merged.nodes.filter((n) => n.parentId === null).length !== 1) {
    throw new PlanSnapshotError(UNRELATED_ROOT);
  }

  const localById = new Map(local.nodes.map((n) => [n.id, n]));
  const kept = new Map<string, PlanMirrorConflict[]>();
  for (const c of merge.conflicts) kept.set(c.nodeId, [...(kept.get(c.nodeId) ?? []), c]);
  const targets = merged.nodes.map((n) => {
    const target: Record<string, unknown> = { ...n };
    for (const c of kept.get(n.id) ?? []) target[c.field] = localById.get(n.id)?.[c.field];
    return target as PlanMirror['nodes'][number];
  });
  const targetById = new Map(targets.map((n) => [n.id, n]));

  const created = targets.filter((n) => !localById.has(n.id));
  if (created.length > 0) {
    const clash = await tx
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(
        inArray(
          schema.planNodes.id,
          created.map((n) => n.id),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw new PlanSnapshotError(
        'the incoming plan contains nodes that belong to another repository',
      );
    }
  }

  // Parents before children so `path` can be built; the guard stops a looping parentage.
  const pathById = new Map<string, string>();
  const ordered: typeof targets = [];
  const resolving = new Set<string>();
  const place = (id: string): boolean => {
    if (pathById.has(id)) return true;
    if (resolving.has(id)) return false;
    const node = targetById.get(id);
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
  for (const n of targets) {
    if (!place(n.id)) {
      throw new PlanSnapshotError(
        `the incoming plan's parentage does not resolve for node ${n.id}`,
      );
    }
  }

  const createdIds = new Set(created.map((n) => n.id));
  const insertRows = ordered
    .filter((n) => createdIds.has(n.id))
    .map((n) => ({
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
      createdBy: 'import' as const,
    }));
  if (insertRows.length > 0) await tx.insert(schema.planNodes).values(insertRows);

  let nodesUpdated = 0;
  for (const node of ordered) {
    const before = localById.get(node.id);
    if (!before) continue;
    const set: Record<string, unknown> = {};
    for (const field of NODE_FIELDS) if (node[field] !== before[field]) set[field] = node[field];
    if (Object.keys(set).length === 0) continue;
    if (set.status !== undefined) {
      if (node.status === 'done') set.doneAt = new Date();
      else if (before.status === 'done') set.doneAt = null;
    }
    const updated = await tx
      .update(schema.planNodes)
      .set({
        ...set,
        sourceTaskId: null,
        version: sql`${schema.planNodes.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.planNodes.id, node.id),
          eq(schema.planNodes.version, versionOf.get(node.id) ?? -1),
        ),
      )
      .returning({ id: schema.planNodes.id });
    if (updated.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
    versionOf.set(node.id, (versionOf.get(node.id) ?? 0) + 1);
    nodesUpdated++;
  }

  if (merge.deleted.length > 0) {
    // A child added meanwhile under a deleted node would go with it by cascade. Locking the parents
    // first makes a child insert (which key-share locks its parent) wait, so the check stays true.
    await tx
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(inArray(schema.planNodes.id, merge.deleted))
      .for('update');
    const [stray] = await tx
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(
        and(
          inArray(schema.planNodes.parentId, merge.deleted),
          notInArray(schema.planNodes.id, merge.deleted),
        ),
      )
      .limit(1);
    if (stray) throw new PlanMirrorHeldError(HELD_RACED);
    for (const id of merge.deleted) {
      const gone = await tx
        .delete(schema.planNodes)
        .where(
          and(eq(schema.planNodes.id, id), eq(schema.planNodes.version, versionOf.get(id) ?? -1)),
        )
        .returning({ id: schema.planNodes.id });
      if (gone.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
    }
  }

  // A moved subtree changes its descendants' ancestry, so every stored path is checked.
  const stored = await tx
    .select({ id: schema.planNodes.id, path: schema.planNodes.path })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId));
  for (const row of stored) {
    const expected = pathById.get(row.id);
    if (expected !== undefined && expected !== row.path) {
      // A node created by this reconcile has no read version, and nobody else can see it yet; any
      // other row without one appeared after the versions were read.
      const read = versionOf.get(row.id);
      if (read === undefined && !createdIds.has(row.id)) throw new PlanMirrorHeldError(HELD_RACED);
      const repaired = await tx
        .update(schema.planNodes)
        .set({ path: expected })
        .where(
          read === undefined
            ? eq(schema.planNodes.id, row.id)
            : and(eq(schema.planNodes.id, row.id), eq(schema.planNodes.version, read)),
        )
        .returning({ id: schema.planNodes.id });
      if (repaired.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
    }
  }

  const edgeKey = (from: string, to: string, kind: string): string =>
    JSON.stringify([from, to, kind]);
  const edgeRows = await tx
    .select({
      id: schema.planNodeEdges.id,
      fromNodeId: schema.planNodeEdges.fromNodeId,
      toNodeId: schema.planNodeEdges.toNodeId,
      kind: schema.planNodeEdges.kind,
      note: schema.planNodeEdges.note,
    })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, repositoryId));
  const wantedEdges = new Map(
    merged.edges
      .filter((e) => e.fromNodeId !== e.toNodeId)
      .map((e) => [edgeKey(e.fromNodeId, e.toNodeId, e.kind), e]),
  );
  // Links carry no version, so the rows must still be the ones the render saw; a patch that added
  // or changed one meanwhile holds the reconcile rather than being undone.
  const cascaded = new Set(merge.deleted);
  const renderedEdges = new Map(
    (localRender?.edges ?? [])
      .filter((e) => !cascaded.has(e.fromNodeId) && !cascaded.has(e.toNodeId))
      .map((e) => [e.id, e]),
  );
  if (
    edgeRows.length !== renderedEdges.size ||
    edgeRows.some((e) => {
      const seen = renderedEdges.get(e.id);
      return (
        !seen ||
        edgeKey(seen.fromNodeId, seen.toNodeId, seen.kind) !==
          edgeKey(e.fromNodeId, e.toNodeId, e.kind) ||
        seen.note !== e.note
      );
    })
  ) {
    throw new PlanMirrorHeldError(HELD_RACED);
  }
  const haveEdges = new Map(edgeRows.map((e) => [edgeKey(e.fromNodeId, e.toNodeId, e.kind), e]));
  const staleEdges = edgeRows.filter(
    (e) => !wantedEdges.has(edgeKey(e.fromNodeId, e.toNodeId, e.kind)),
  );
  const edgeAsRead = (e: (typeof edgeRows)[number]) =>
    and(
      eq(schema.planNodeEdges.id, e.id),
      sql`${schema.planNodeEdges.note} is not distinct from ${e.note}`,
    );
  for (const e of staleEdges) {
    const gone = await tx
      .delete(schema.planNodeEdges)
      .where(edgeAsRead(e))
      .returning({ id: schema.planNodeEdges.id });
    if (gone.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
  }
  for (const [key, edge] of wantedEdges) {
    const have = haveEdges.get(key);
    if (have && have.note !== edge.note) {
      const changed = await tx
        .update(schema.planNodeEdges)
        .set({ note: edge.note })
        .where(edgeAsRead(have))
        .returning({ id: schema.planNodeEdges.id });
      if (changed.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
    }
  }
  const newEdges = [...wantedEdges].filter(([key]) => !haveEdges.has(key)).map(([, e]) => e);
  let edgesAdded = 0;
  if (newEdges.length > 0) {
    const inserted = await tx
      .insert(schema.planNodeEdges)
      .values(
        newEdges.map((e) => ({
          repositoryId,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          kind: e.kind as 'affects',
          note: e.note,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.planNodeEdges.id });
    // A row that already existed was added by a patch since the read; its note was never merged.
    if (inserted.length < newEdges.length) throw new PlanMirrorHeldError(HELD_RACED);
    edgesAdded = inserted.length;
  }

  const linkKey = (nodeId: string, repoPath: string, symbol: string | null): string =>
    JSON.stringify([nodeId, repoPath, symbol ?? '']);
  const linkRows = await tx
    .select({
      id: schema.planNodeCodeLinks.id,
      nodeId: schema.planNodeCodeLinks.nodeId,
      repoPath: schema.planNodeCodeLinks.repoPath,
      symbol: schema.planNodeCodeLinks.symbol,
      evidence: schema.planNodeCodeLinks.evidence,
      derivedAtCommit: schema.planNodeCodeLinks.derivedAtCommit,
      stale: schema.planNodeCodeLinks.stale,
      role: schema.planNodeCodeLinks.role,
    })
    .from(schema.planNodeCodeLinks)
    .where(eq(schema.planNodeCodeLinks.repositoryId, repositoryId));
  const wantedLinks = new Map(
    merged.codeLinks.map((l) => [linkKey(l.nodeId, l.repoPath, l.symbol), l]),
  );
  const sameLink = (
    a: { evidence: unknown; derivedAtCommit: unknown; stale: unknown; role: unknown },
    b: { evidence: unknown; derivedAtCommit: unknown; stale: unknown; role: unknown },
  ) =>
    a.evidence === b.evidence &&
    a.derivedAtCommit === b.derivedAtCommit &&
    a.stale === b.stale &&
    a.role === b.role;
  const renderedLinks = new Map(
    local.codeLinks
      .filter((l) => !cascaded.has(l.nodeId))
      .map((l) => [linkKey(l.nodeId, l.repoPath, l.symbol), l]),
  );
  if (
    linkRows.length !== renderedLinks.size ||
    linkRows.some((l) => {
      const seen = renderedLinks.get(linkKey(l.nodeId, l.repoPath, l.symbol));
      return !seen || !sameLink(seen, l);
    })
  ) {
    throw new PlanMirrorHeldError(HELD_RACED);
  }
  const haveLinks = new Map(linkRows.map((l) => [linkKey(l.nodeId, l.repoPath, l.symbol), l]));
  const staleLinks = linkRows.filter(
    (l) => !wantedLinks.has(linkKey(l.nodeId, l.repoPath, l.symbol)),
  );
  const linkAsRead = (l: (typeof linkRows)[number]) =>
    and(
      eq(schema.planNodeCodeLinks.id, l.id),
      sql`${schema.planNodeCodeLinks.evidence} is not distinct from ${l.evidence}`,
      sql`${schema.planNodeCodeLinks.derivedAtCommit} is not distinct from ${l.derivedAtCommit}`,
      eq(schema.planNodeCodeLinks.stale, l.stale),
      eq(schema.planNodeCodeLinks.role, l.role),
    );
  for (const l of staleLinks) {
    const gone = await tx
      .delete(schema.planNodeCodeLinks)
      .where(linkAsRead(l))
      .returning({ id: schema.planNodeCodeLinks.id });
    if (gone.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
  }
  for (const [key, link] of wantedLinks) {
    const have = haveLinks.get(key);
    if (have && !sameLink(have, link)) {
      const changed = await tx
        .update(schema.planNodeCodeLinks)
        .set({
          evidence: link.evidence,
          derivedAtCommit: link.derivedAtCommit,
          stale: link.stale,
          role: link.role as 'implements',
          updatedAt: new Date(),
        })
        .where(linkAsRead(have))
        .returning({ id: schema.planNodeCodeLinks.id });
      if (changed.length === 0) throw new PlanMirrorHeldError(HELD_RACED);
    }
  }
  const newLinks = [...wantedLinks].filter(([key]) => !haveLinks.has(key)).map(([, l]) => l);
  let codeLinksAdded = 0;
  if (newLinks.length > 0) {
    const inserted = await tx
      .insert(schema.planNodeCodeLinks)
      .values(
        newLinks.map((l) => ({
          repositoryId,
          nodeId: l.nodeId,
          repoPath: l.repoPath,
          symbol: l.symbol,
          evidence: l.evidence,
          derivedAtCommit: l.derivedAtCommit,
          stale: l.stale,
          role: l.role as 'implements',
          confidence: null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.planNodeCodeLinks.id });
    if (inserted.length < newLinks.length) throw new PlanMirrorHeldError(HELD_RACED);
    codeLinksAdded = inserted.length;
  }

  // A question records this side's value, so it must still be the value read.
  const askedIds = [...new Set(merge.conflicts.map((c) => c.nodeId))];
  if (askedIds.length > 0) {
    const current = await tx
      .select({ id: schema.planNodes.id, version: schema.planNodes.version })
      .from(schema.planNodes)
      .where(inArray(schema.planNodes.id, askedIds))
      .for('update');
    const moved = askedIds.some(
      (id) => current.find((r) => r.id === id)?.version !== versionOf.get(id),
    );
    if (moved) throw new PlanMirrorHeldError(HELD_RACED);
  }
  await recordPlanQuestions(tx, repositoryId, merge.conflicts);

  // The next base: the checkout as read, each contested field still at its old base so it is asked again.
  const atBase = new Map(
    merge.conflicts
      .filter((c) => c.base !== undefined)
      .map((c) => [`${c.nodeId}\0${c.field}`, c.base]),
  );
  const snapshot: PlanMirrorPayload = withoutAbsentAsked(
    atBase.size === 0
      ? incoming
      : ({
          ...incoming,
          nodes: incoming.nodes.map((n) => {
            const patched: Record<string, unknown> = { ...n };
            for (const field of PLAN_MIRROR_ASKED_FIELDS) {
              const key = `${n.id}\0${field}`;
              if (atBase.has(key)) patched[field] = atBase.get(key);
            }
            return patched;
          }),
        } as PlanMirrorPayload),
    new Set(merge.conflicts.filter((c) => c.base === undefined).map((c) => c.nodeId)),
    new Map(baseParsed.success ? baseParsed.data.nodes.map((n) => [n.id, n]) : []),
  );

  // Dirty when the file no longer says what the database does.
  const after = await renderPlanMirrorFiles(tx, repositoryId);
  // A question leaves plan.json as read but plan.md on this side's value, so it is written too.
  if (after === null || hashBytes(after.json) !== hash || merge.conflicts.length > 0) {
    await markPlanMirrorDirty(tx, repositoryId);
  }
  await tx
    .insert(schema.planMirrorState)
    .values({
      repositoryId,
      revision: 0,
      writtenRevision: 0,
      syncedHash: hash,
      syncedSnapshot: snapshot,
    })
    .onConflictDoUpdate({
      target: schema.planMirrorState.repositoryId,
      set: { syncedHash: hash, syncedSnapshot: snapshot },
    });

  const keptLocal = targets
    .filter((n) => localById.has(n.id) && !incomingIds.has(n.id))
    .map((n) => n.id);
  logger.info(
    {
      repositoryId,
      nodesCreated: created.length,
      nodesUpdated,
      nodesDeleted: merge.deleted.length,
      keptLocal: keptLocal.length,
      conflicts: merge.conflicts.length,
      edgesAdded,
    },
    'reconciled plan from pulled .haive-data mirror',
  );
  return {
    previousCommit: null,
    fastForwarded: false,
    nodesCreated: created.length,
    nodesUpdated,
    keptLocal,
    edgesAdded,
    codeLinksAdded,
    skipped: null,
    nodesDeleted: merge.deleted,
    conflicts: merge.conflicts.map((c) => ({ nodeId: c.nodeId, field: c.field })),
    reported: merge.reported.map((r) => ({
      kind: r.kind,
      subject: r.subject,
      ...(r.field ? { field: r.field } : {}),
      ...(r.deletedBy ? { deletedBy: r.deletedBy } : {}),
    })),
  } satisfies PlanPullOutcome;
}

/** One pending row per contested field; a pending plan row that no longer conflicts converged. */
async function recordPlanQuestions(
  tx: PlanMirrorTx,
  repositoryId: string,
  conflicts: readonly PlanMirrorConflict[],
): Promise<void> {
  const pending = new Map(
    (await loadPendingPlanQuestions(tx, repositoryId)).map((q) => [q.row.unit, q.row]),
  );
  const open = new Set<string>();
  for (const c of conflicts) {
    const unit = planConflictUnit(c.nodeId, c.field);
    open.add(unit);
    const sides = {
      base: conflictSide(c.base),
      local: conflictSide(c.local),
      incoming: conflictSide(c.incoming),
    };
    const row = pending.get(unit);
    if (!row) {
      await tx.insert(schema.projectStateConflicts).values({ repositoryId, unit, ...sides });
    } else if (
      !sameValue(row.base, sides.base) ||
      !sameValue(row.local, sides.local) ||
      !sameValue(row.incoming, sides.incoming)
    ) {
      await tx
        .update(schema.projectStateConflicts)
        .set(sides)
        .where(eq(schema.projectStateConflicts.id, row.id));
    }
  }
  await closePlanQuestions(tx, repositoryId, open);
}

async function closePlanQuestions(
  tx: PlanMirrorTx,
  repositoryId: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  for (const { row } of await loadPendingPlanQuestions(tx, repositoryId)) {
    if (keep.has(row.unit)) continue;
    await tx
      .update(schema.projectStateConflicts)
      .set({ resolution: 'converged', resolvedAt: new Date() })
      .where(eq(schema.projectStateConflicts.id, row.id));
  }
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
  // A repository with no plan falls through: its flush removes nothing and retires the row.
  if (await checkoutMissing(repoPath)) {
    const [node] = await db
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repositoryId))
      .limit(1);
    if (node) throw new PlanMirrorHeldError(HELD_NO_CHECKOUT, 'checkout_missing');
  }
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
        const onDisk = await readPlanJson(repoPath);
        const matches =
          rendered === null
            ? onDisk === null
            : Buffer.isBuffer(onDisk) && onDisk.equals(Buffer.from(rendered.json, 'utf8'));
        if (!matches) return false;
        await stampSyncedHash(
          tx,
          repositoryId,
          Buffer.isBuffer(onDisk) ? hashBytes(onDisk) : ABSENT_HASH,
        );
        return true;
      });
      if (done) stamped++;
    } catch (err) {
      logger.warn({ err, repositoryId }, 'plan mirror hash not stamped at boot');
    }
  }
  return stamped;
}

/** Before a Pull moves the checkout: a row stamped before 0196 stores the bytes it last read as its
 *  base while they are still on disk, since the reconcile after the move can no longer see them. */
export async function seedPlanBaseFromCheckout(
  db: Database,
  repositoryId: string,
  repoPath: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPlanMirror(tx, repositoryId);
    const [state] = await tx
      .select({
        syncedHash: schema.planMirrorState.syncedHash,
        hasBase: sql<boolean>`${schema.planMirrorState.syncedSnapshot} is not null`,
      })
      .from(schema.planMirrorState)
      .where(eq(schema.planMirrorState.repositoryId, repositoryId))
      .limit(1);
    if (!state?.syncedHash || state.hasBase) return;
    const bytes = await readPlanJson(repoPath);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
    if (hashBytes(bytes) === state.syncedHash) await seedBaseFrom(tx, repositoryId, bytes);
  });
}

/** For a reconcile no caller retries (a rescan): the reason is kept and the row left dirty, so the
 *  sweep's flush meets the same file and holds with it until it can be read in. */
export async function recordPlanReconcileFailure(
  db: Database,
  repositoryId: string,
  err: unknown,
): Promise<void> {
  await markPlanMirrorDirty(db, repositoryId);
  await recordPlanMirrorError(db, repositoryId, err);
}

export async function recordPlanMirrorError(
  db: Database,
  repositoryId: string,
  err: unknown,
): Promise<void> {
  if (planMirrorErrorsSuppressed()) return;
  const message = scrubErrorPaths(err);
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
