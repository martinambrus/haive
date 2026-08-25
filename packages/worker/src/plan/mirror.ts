import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inArray, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  HAIVE_DATA_FILES,
  PLAN_MIRROR_SCHEMA_VERSION,
  logger,
  type PlanMirror,
} from '@haive/shared';
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
 *   - `plan.json` is the machine-readable restore point. Node ids are carried
 *     VERBATIM, because the spec writer names plan node ids in its "Affected
 *     components" section and `plan.md` quotes them — a restore that renumbered
 *     would silently invalidate every stored reference.
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
  const [nodes, edges] = await Promise.all([
    loadPlanNodes(db, repositoryId),
    loadPlanEdges(db, repositoryId),
  ]);
  if (nodes.length === 0) return [];

  const mirror: PlanMirror = {
    schemaVersion: PLAN_MIRROR_SCHEMA_VERSION,
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      ordinal: n.ordinal,
      title: n.title,
      kind: n.kind,
      body: n.body,
      status: n.status,
      taskable: n.taskable,
      createdBy: n.createdBy,
    })),
    edges: edges.map((e) => ({
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      kind: e.kind,
      note: e.note,
    })),
  };

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(repoPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    written.push(rel);
  };

  await write(HAIVE_DATA_FILES.plan, `${JSON.stringify(mirror, null, 2)}\n`);
  await write(HAIVE_DATA_FILES.planMarkdown, renderPlanMarkdownFrom(nodes, edges));
  return written;
}

/**
 * Restore a plan from a fresh clone's committed mirror.
 *
 * This is the ONE writer that does not go through `applyPlanPatch`, and the
 * reason is the point of a mirror: it restores state VERBATIM, ids included, and
 * the patch contract cannot express "create this node with exactly this id" —
 * nor should it, since every other caller must not be able to.
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
  let mirror: PlanMirror;
  try {
    const raw = await readFile(path.join(storagePath, HAIVE_DATA_FILES.plan), 'utf8');
    mirror = JSON.parse(raw) as PlanMirror;
  } catch {
    return { imported: false, reason: 'no plan mirror' };
  }

  if (mirror?.schemaVersion !== PLAN_MIRROR_SCHEMA_VERSION) {
    return {
      imported: false,
      reason: `schemaVersion ${String(mirror?.schemaVersion)} not supported`,
    };
  }
  if (!Array.isArray(mirror.nodes) || mirror.nodes.length === 0) {
    return { imported: false, reason: 'mirror has no nodes' };
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
  const ids = mirror.nodes.map((n) => n.id);
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
  const byId = new Map(mirror.nodes.map((n) => [n.id, n]));
  const pathById = new Map<string, string>();
  const ordered: typeof mirror.nodes = [];
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
  for (const n of mirror.nodes) {
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
        createdBy: n.createdBy as 'import',
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
  });

  logger.info(
    { repositoryId, nodes: ordered.length, edges: mirror.edges?.length ?? 0 },
    'restored plan from .haive-data mirror',
  );
  return { imported: true };
}
