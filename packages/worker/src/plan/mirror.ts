import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  HAIVE_DATA_FILES,
  PLAN_MIRROR_SCHEMA_VERSION,
  logger,
  type PlanMirror,
} from '@haive/shared';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import {
  loadPlanEdges,
  loadPlanNodes,
  renderPlanMarkdownFrom,
  planNodePath,
} from '@haive/shared/plan';

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

/** Write both mirror files. Returns the repo-relative paths written. */
export async function writePlanMirror(
  db: Database,
  repositoryId: string,
  repoPath: string,
): Promise<string[]> {
  try {
    return await db.transaction(async (tx) => {
      // Every writer (queue, plan steps, onboarding) enters here. Serialize per
      // repository across worker processes so an older render can never rename
      // over a newer one after the newer writer already marked itself current.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`);
      return writePlanMirrorLocked(tx, repositoryId, repoPath);
    });
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
): Promise<string[]> {
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
      })
      .from(schema.planNodeCodeLinks)
      .where(eq(schema.planNodeCodeLinks.repositoryId, repositoryId)),
  ]);

  if (nodes.length === 0) {
    await Promise.all(
      [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown].map((rel) =>
        rm(path.join(repoPath, rel), { force: true }),
      ),
    );
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
    return [];
  }

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

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(repoPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const temporary = `${abs}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, abs);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw err;
    }
    written.push(rel);
  };

  await write(HAIVE_DATA_FILES.plan, `${JSON.stringify(mirror, null, 2)}\n`);
  await write(HAIVE_DATA_FILES.planMarkdown, renderPlanMarkdownFrom(nodes, edges));
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
  return written;
}

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
): Promise<{ imported: boolean; reason?: string }> {
  let rawPayload: unknown;
  try {
    const raw = await readFile(path.join(storagePath, HAIVE_DATA_FILES.plan), 'utf8');
    rawPayload = JSON.parse(raw) as unknown;
  } catch {
    return { imported: false, reason: 'no plan mirror' };
  }

  const parsed = planMirrorPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const version = (rawPayload as { schemaVersion?: unknown } | null)?.schemaVersion;
    return {
      imported: false,
      reason:
        version !== 1 && version !== PLAN_MIRROR_SCHEMA_VERSION
          ? `schemaVersion ${String(version)} not supported`
          : `invalid plan mirror: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    };
  }
  const mirror = parsed.data;
  const mirrorNodes =
    mirror.schemaVersion === 1
      ? mirror.nodes.map((node) => ({ ...node, createdBy: node.createdBy }))
      : mirror.nodes.map((node) => ({ ...node, createdBy: 'import' as const }));
  if (!Array.isArray(mirror.nodes) || mirror.nodes.length === 0) {
    return { imported: false, reason: 'mirror has no nodes' };
  }

  const roots = mirrorNodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) {
    return {
      imported: false,
      reason: `plan mirror must contain exactly one root (found ${roots.length})`,
    };
  }
  const ids = mirrorNodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return { imported: false, reason: 'plan mirror contains duplicate node refs' };
  }
  for (const edge of mirror.edges) {
    if (!uniqueIds.has(edge.fromNodeId) || !uniqueIds.has(edge.toNodeId)) {
      return { imported: false, reason: 'plan mirror contains a dangling plan link' };
    }
    if (edge.fromNodeId === edge.toNodeId) {
      return { imported: false, reason: 'plan mirror contains a self-referencing plan link' };
    }
  }
  const codeLinks = mirror.schemaVersion === 2 ? mirror.codeLinks : [];
  for (const link of codeLinks) {
    if (!uniqueIds.has(link.nodeId)) {
      return { imported: false, reason: 'plan mirror contains a dangling code link' };
    }
  }
  const edgeKeys = mirror.edges.map((edge) =>
    [edge.fromNodeId, edge.toNodeId, edge.kind].join('\0'),
  );
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    return { imported: false, reason: 'plan mirror contains duplicate plan links' };
  }
  const codeLinkKeys = codeLinks.map((link) =>
    [link.nodeId, link.repoPath, link.symbol ?? ''].join('\0'),
  );
  if (new Set(codeLinkKeys).size !== codeLinkKeys.length) {
    return { imported: false, reason: 'plan mirror contains duplicate code links' };
  }

  const [existing] = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .limit(1);
  if (existing) return { imported: false, reason: 'repository already has a plan' };

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
    return { imported: false, reason: 'these plan nodes already exist under another repository' };
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
      return { imported: false, reason: `plan mirror parentage does not resolve for node ${n.id}` };
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
      })
      .onConflictDoUpdate({
        target: schema.planMirrorState.repositoryId,
        set: {
          revision,
          writtenRevision: revision,
          lastError: null,
          writtenAt: new Date(),
          updatedAt: new Date(),
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
