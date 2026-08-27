import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  createPlanEdgeRequestSchema,
  createPlanNodeRequestSchema,
  planAdvisoryRequestSchema,
  planBuildRequestSchema,
  planChatRequestSchema,
  updatePlanNodeRequestSchema,
  type PlanPatch,
} from '@haive/shared';
import {
  PlanPatchError,
  ancestryOf,
  applyPlanPatch,
  computeImpact,
  findPlanRoot,
  loadPlanEdges,
  loadPlanNode,
  loadPlanNodes,
  loadPlanSkeletons,
  renderImpactMermaid,
  toEdgeViews,
  toNodeViews,
} from '@haive/shared/plan';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { spawnPlanTask } from '../lib/spawn-plan-task.js';

export const planRoutes = new Hono<AppEnv>();

planRoutes.use('*', requireAuth);

/** 404 unless the repository exists and belongs to the caller. Every route in
 *  this file goes through it — a plan is repo-scoped, so ownership of the repo
 *  IS the authorization check. */
async function requireOwnedRepo(c: {
  get: (k: 'userId') => string;
  req: { param: (k: string) => string };
}) {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const repo = await getDb().query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true, name: true, storagePath: true, localPath: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  return { userId, repositoryId, repo };
}

/** Map the shared applier's typed refusal onto HTTP. `conflict` is a 409 the UI
 *  must SHOW: a silent refetch would discard the loser's edit without telling
 *  anyone it happened. */
function planError(err: unknown): never {
  if (err instanceof PlanPatchError) {
    const status = err.kind === 'conflict' ? 409 : err.kind === 'not_found' ? 404 : 400;
    throw new HttpError(status, err.message, `plan_${err.kind}`);
  }
  throw err;
}

async function requirePlanCanvasEnabled(): Promise<void> {
  const enabled = await configService.get(CONFIG_KEYS.PLAN_CANVAS_ENABLED);
  if (enabled === 'false') {
    throw new HttpError(409, 'The plan canvas is disabled', 'plan_canvas_disabled');
  }
}

async function requireNode(repositoryId: string, nodeId: string) {
  const node = await loadPlanNode(getDb(), repositoryId, nodeId);
  if (!node) throw new HttpError(404, 'Plan node not found');
  return node;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Root plus its immediate children. The entry point the canvas loads first;
 *  descending fetches one level at a time, so nothing preloads the whole tree. */
planRoutes.get('/:id/plan', async (c) => {
  const { repositoryId, repo } = await requireOwnedRepo(c);
  const db = getDb();
  const skeletons = await loadPlanSkeletons(db, repositoryId);
  const root = skeletons.find((n) => n.parentId === null) ?? null;
  if (!root) {
    return c.json({ repositoryName: repo.name, root: null, children: [], nodeCount: 0 });
  }
  const children = skeletons.filter((n) => n.parentId === root.id);
  const bodies = new Map([
    [root.id, (await loadPlanNode(db, repositoryId, root.id))?.body ?? null],
  ]);
  return c.json({
    repositoryName: repo.name,
    root: toNodeViews(skeletons, [root], bodies)[0],
    children: toNodeViews(skeletons, children),
    nodeCount: skeletons.length,
  });
});

/** Hierarchy only — id, title, status, parentage. Feeds the tree view, which the
 *  user asked to show no edges. */
planRoutes.get('/:id/plan/tree', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const skeletons = await loadPlanSkeletons(getDb(), repositoryId);
  return c.json({
    nodes: toNodeViews(skeletons, skeletons).map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      kind: n.kind,
      status: n.status,
      rolledStatus: n.rolledStatus,
      taskable: n.taskable,
      directChildren: n.directChildren,
      totalDescendants: n.totalDescendants,
    })),
  });
});

/**
 * Unread assistant turns per node, for the badges on the tree, the tiles and
 * the Chat tab.
 *
 * Its own endpoint rather than a field on the tree: the tree, the node detail
 * and the overview are three separate calls that all build from the same node
 * views, so threading a count through them would cost three aggregates per
 * refresh and change a type the worker shares. One map serves all three
 * surfaces.
 *
 * Counts are NOT rolled up to ancestors. A badge on a parent tells the user
 * something is unread somewhere beneath it and leaves them to search a subtree
 * for it; a badge only where the reply actually landed is a destination.
 */
planRoutes.get('/:id/plan/unread', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  const rows = await getDb()
    .select({
      nodeId: schema.planNodeMessages.nodeId,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.planNodeMessages)
    .innerJoin(schema.planNodes, eq(schema.planNodes.id, schema.planNodeMessages.nodeId))
    .leftJoin(
      schema.userPlanNodeReads,
      and(
        eq(schema.userPlanNodeReads.nodeId, schema.planNodeMessages.nodeId),
        eq(schema.userPlanNodeReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.planNodes.repositoryId, repositoryId),
        // The user's own turns are not news to them.
        eq(schema.planNodeMessages.role, 'assistant'),
        // No read row means nothing has been read, so every turn counts — the
        // honest reading for a chat that has never been opened.
        sql`(${schema.userPlanNodeReads.lastReadAt} is null or ${schema.planNodeMessages.createdAt} > ${schema.userPlanNodeReads.lastReadAt})`,
      ),
    )
    .groupBy(schema.planNodeMessages.nodeId);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.nodeId] = row.n;
  return c.json({ counts });
});

/** Mark one node's chat read up to now. Idempotent; re-reading just moves the
 *  stamp forward. */
planRoutes.put('/:id/plan/nodes/:nodeId/read', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  const nodeId = c.req.param('nodeId');
  await requireNode(repositoryId, nodeId);
  const lastReadAt = new Date();
  await getDb()
    .insert(schema.userPlanNodeReads)
    .values({ userId, nodeId, lastReadAt })
    .onConflictDoUpdate({
      target: [schema.userPlanNodeReads.userId, schema.userPlanNodeReads.nodeId],
      set: { lastReadAt },
    });
  return c.json({ ok: true, lastReadAt: lastReadAt.toISOString() });
});

planRoutes.get('/:id/plan/search', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  if (q.length < 2) return c.json({ matches: [] });

  const db = getDb();
  const [skeletons, nodes] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanNodes(db, repositoryId),
  ]);
  const bodyById = new Map(nodes.map((n) => [n.id, n.body ?? '']));
  const hits = skeletons.filter(
    (n) => n.title.toLowerCase().includes(q) || bodyById.get(n.id)!.toLowerCase().includes(q),
  );
  // The breadcrumb ships with each hit so the UI can jump straight to a match at
  // depth 6 without walking the tree a level at a time to get there.
  return c.json({
    matches: toNodeViews(skeletons, hits).map((n) => ({
      ...n,
      body: null,
      ancestry: ancestryOf(skeletons, n.id).map((a) => ({ id: a.id, title: a.title })),
    })),
  });
});

/** One node in full: body, children, edges, code links, linked tasks, breadcrumb. */
planRoutes.get('/:id/plan/nodes/:nodeId', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const nodeId = c.req.param('nodeId');
  const db = getDb();
  const node = await requireNode(repositoryId, nodeId);
  const skeletons = await loadPlanSkeletons(db, repositoryId);
  const children = skeletons.filter((n) => n.parentId === nodeId);
  const edges = await loadPlanEdges(db, repositoryId);
  const titleById = new Map(skeletons.map((n) => [n.id, n.title]));

  const codeLinks = await db
    .select()
    .from(schema.planNodeCodeLinks)
    .where(eq(schema.planNodeCodeLinks.nodeId, nodeId))
    .orderBy(asc(schema.planNodeCodeLinks.repoPath));

  const tasks = await db
    .select({
      taskId: schema.planNodeTasks.taskId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      type: schema.tasks.type,
      createdAt: schema.tasks.createdAt,
    })
    .from(schema.planNodeTasks)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.planNodeTasks.taskId))
    .where(eq(schema.planNodeTasks.nodeId, nodeId))
    .orderBy(asc(schema.tasks.createdAt));

  return c.json({
    node: toNodeViews(skeletons, [node], new Map([[node.id, node.body]]))[0],
    ancestry: ancestryOf(skeletons, nodeId).map((a) => ({ id: a.id, title: a.title })),
    children: toNodeViews(skeletons, children),
    edges: toEdgeViews(edges.filter((e) => e.fromNodeId === nodeId || e.toNodeId === nodeId)).map(
      (e) => ({
        ...e,
        fromTitle: titleById.get(e.fromNodeId) ?? null,
        toTitle: titleById.get(e.toNodeId) ?? null,
      }),
    ),
    codeLinks,
    tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
  });
});

planRoutes.get('/:id/plan/nodes/:nodeId/messages', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const nodeId = c.req.param('nodeId');
  await requireNode(repositoryId, nodeId);
  const db = getDb();
  // Left join: a turn from before the provider was recorded, or one whose
  // provider has since been deleted, still belongs in the transcript — it just
  // cannot say which CLI wrote it.
  const rows = await db
    .select({
      id: schema.planNodeMessages.id,
      nodeId: schema.planNodeMessages.nodeId,
      taskId: schema.planNodeMessages.taskId,
      role: schema.planNodeMessages.role,
      body: schema.planNodeMessages.body,
      patchJson: schema.planNodeMessages.patchJson,
      createdAt: schema.planNodeMessages.createdAt,
      cliLabel: schema.cliProviders.label,
    })
    .from(schema.planNodeMessages)
    .leftJoin(
      schema.cliProviders,
      eq(schema.cliProviders.id, schema.planNodeMessages.cliProviderId),
    )
    .where(eq(schema.planNodeMessages.nodeId, nodeId))
    .orderBy(asc(schema.planNodeMessages.createdAt));

  // The state of each conversation these messages belong to. Sent with the
  // transcript rather than fetched per task by the client: the chat panel needs
  // it for EVERY group it renders, and one join beats a request per group.
  const taskIds = [...new Set(rows.map((m) => m.taskId).filter((id): id is string => id !== null))];
  const conversations =
    taskIds.length === 0
      ? []
      : (
          await db
            .select({
              taskId: schema.tasks.id,
              status: schema.tasks.status,
              completedAt: schema.tasks.completedAt,
            })
            .from(schema.tasks)
            .where(inArray(schema.tasks.id, taskIds))
        ).map((t) => ({
          taskId: t.taskId,
          status: t.status,
          completedAt: t.completedAt ? t.completedAt.toISOString() : null,
        }));

  return c.json({
    messages: rows.map((m) => ({
      id: m.id,
      nodeId: m.nodeId,
      taskId: m.taskId,
      role: m.role,
      body: m.body,
      patch: (m.patchJson ?? null) as PlanPatch | null,
      cliLabel: m.cliLabel ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    conversations,
  });
});

/** The transitive affected set, plus the mermaid source the detail panel and
 *  gate 1 both render. The cap is reported in the payload, never applied
 *  silently — a short list read as "nothing else is affected" is the failure
 *  mode this whole view exists to prevent. */
planRoutes.get('/:id/plan/impact/:nodeId', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const nodeId = c.req.param('nodeId');
  const db = getDb();
  await requireNode(repositoryId, nodeId);

  const [skeletons, edges] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanEdges(db, repositoryId),
  ]);
  const depthParam = Number(c.req.query('maxDepth'));
  const impact = computeImpact(nodeId, edges, {
    ...(Number.isFinite(depthParam) && depthParam > 0 ? { maxDepth: depthParam } : {}),
  });
  const titleById = new Map(skeletons.map((n) => [n.id, n.title]));
  const byId = new Map(skeletons.map((n) => [n.id, n]));

  const affectedIds = impact.hops.map((h) => h.nodeId);
  const codeLinks = affectedIds.length
    ? await db
        .select()
        .from(schema.planNodeCodeLinks)
        .where(eq(schema.planNodeCodeLinks.repositoryId, repositoryId))
    : [];

  return c.json({
    origin: { id: nodeId, title: titleById.get(nodeId) ?? null },
    hops: impact.hops.map((h) => ({
      ...h,
      title: titleById.get(h.nodeId) ?? null,
      status: byId.get(h.nodeId)?.status ?? null,
    })),
    truncated: impact.truncated,
    mermaid: renderImpactMermaid(impact, titleById),
    codeLinks: codeLinks.filter((l) => l.nodeId === nodeId || affectedIds.includes(l.nodeId)),
  });
});

/* ------------------------------------------------------------------ */
/* Writes — all through applyPlanPatch                                 */
/* ------------------------------------------------------------------ */

planRoutes.post('/:id/plan/nodes', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = createPlanNodeRequestSchema.parse(await c.req.json());
  const db = getDb();

  // parentId absent means "the root" only when there is no plan yet; otherwise a
  // node with no stated parent would try to create a second root, which the
  // applier rejects. Defaulting to the existing root is what the UI means by
  // "add a top-level component".
  let parentRef: string | null = body.parentId ?? null;
  if (body.parentId === undefined) {
    const root = await findPlanRoot(db, repositoryId);
    parentRef = root?.id ?? null;
  }

  try {
    const res = await applyPlanPatch(
      db,
      {
        ops: [
          {
            op: 'upsert',
            nodeRef: 'new',
            parentRef,
            title: body.title,
            ...(body.kind ? { kind: body.kind } : {}),
            ...(body.body !== undefined ? { body: body.body } : {}),
            ...(body.taskable !== undefined ? { taskable: body.taskable } : {}),
          },
        ],
      },
      { repositoryId, origin: 'user' },
    );
    const created = res.created[0]!;
    return c.json({ node: await loadPlanNode(db, repositoryId, created) }, 201);
  } catch (err) {
    planError(err);
  }
});

planRoutes.patch('/:id/plan/nodes/:nodeId', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const nodeId = c.req.param('nodeId');
  const body = updatePlanNodeRequestSchema.parse(await c.req.json());
  const db = getDb();
  await requireNode(repositoryId, nodeId);

  try {
    await applyPlanPatch(
      db,
      {
        ops: [
          {
            op: 'upsert',
            nodeRef: nodeId,
            expectedVersion: body.expectedVersion,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.body !== undefined ? { body: body.body } : {}),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.taskable !== undefined ? { taskable: body.taskable } : {}),
            ...(body.parentId !== undefined ? { parentRef: body.parentId } : {}),
            ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
          },
        ],
      },
      { repositoryId, origin: 'user' },
    );
    return c.json({ node: await loadPlanNode(db, repositoryId, nodeId) });
  } catch (err) {
    planError(err);
  }
});

planRoutes.delete('/:id/plan/nodes/:nodeId', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const nodeId = c.req.param('nodeId');
  const db = getDb();
  await requireNode(repositoryId, nodeId);
  try {
    const res = await applyPlanPatch(
      db,
      { ops: [{ op: 'delete', nodeRef: nodeId }] },
      { repositoryId, origin: 'user' },
    );
    return c.json({ deleted: res.deleted });
  } catch (err) {
    planError(err);
  }
});

planRoutes.post('/:id/plan/edges', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = createPlanEdgeRequestSchema.parse(await c.req.json());
  const db = getDb();
  try {
    await applyPlanPatch(
      db,
      {
        ops: [
          {
            op: 'link',
            fromRef: body.fromNodeId,
            toRef: body.toNodeId,
            kind: body.kind,
            ...(body.note !== undefined ? { note: body.note } : {}),
          },
        ],
      },
      { repositoryId, origin: 'user' },
    );
    const edges = await loadPlanEdges(db, repositoryId);
    const created = edges.find(
      (e) =>
        e.fromNodeId === body.fromNodeId && e.toNodeId === body.toNodeId && e.kind === body.kind,
    );
    return c.json({ edge: created ?? null }, 201);
  } catch (err) {
    planError(err);
  }
});

planRoutes.delete('/:id/plan/edges/:edgeId', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const edgeId = c.req.param('edgeId');
  const db = getDb();
  const [edge] = await db
    .select()
    .from(schema.planNodeEdges)
    .where(
      and(eq(schema.planNodeEdges.id, edgeId), eq(schema.planNodeEdges.repositoryId, repositoryId)),
    )
    .limit(1);
  if (!edge) throw new HttpError(404, 'Plan link not found');
  try {
    await applyPlanPatch(
      db,
      {
        ops: [{ op: 'unlink', fromRef: edge.fromNodeId, toRef: edge.toNodeId, kind: edge.kind }],
      },
      { repositoryId, origin: 'user' },
    );
    return c.json({ deleted: edgeId });
  } catch (err) {
    planError(err);
  }
});

/* ------------------------------------------------------------------ */
/* Task spawning                                                       */
/* ------------------------------------------------------------------ */

/** Validate the caller's chosen provider, or fall back to the one this repo last
 *  ran — the same default the new-task form applies via `/tasks/last-cli`, so a
 *  plan task started from a button lands on the provider the user already picked
 *  for this repo instead of an arbitrary enabled one. Null is a legitimate
 *  answer: the dispatcher resolves a provider per step anyway. */
async function resolveProvider(
  userId: string,
  repositoryId: string,
  cliProviderId?: string,
): Promise<string | null> {
  const db = getDb();
  if (cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(eq(schema.cliProviders.id, cliProviderId), eq(schema.cliProviders.userId, userId)),
      columns: { id: true },
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
    return provider.id;
  }
  const lastUsed = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.userId, userId),
      eq(schema.tasks.repositoryId, repositoryId),
      isNotNull(schema.tasks.cliProviderId),
    ),
    orderBy: [desc(schema.tasks.createdAt)],
    columns: { cliProviderId: true },
  });
  if (lastUsed?.cliProviderId) return lastUsed.cliProviderId;
  const fallback = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.enabled, true)),
    columns: { id: true },
    orderBy: [asc(schema.cliProviders.createdAt)],
  });
  return fallback?.id ?? null;
}

planRoutes.post('/:id/plan/build', async (c) => {
  const { userId, repositoryId, repo } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = planBuildRequestSchema.parse(await c.req.json());
  // from_md decomposes a document uploaded as a task attachment, which needs a
  // volume-backed repo to land in — the same requirement the attachments route
  // enforces, checked here so the user is told before a task is created.
  if (body.mode === 'from_md' && !repo.storagePath) {
    throw new HttpError(409, 'This repository is not ready for uploads yet');
  }
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'plan_build',
    title: body.title?.trim() || `Build plan: ${repo.name}`,
    description: body.description,
    metadata: { planBuildMode: body.mode },
    cliProviderId,
  });
  return c.json({ taskId }, 201);
});

planRoutes.post('/:id/plan/nodes/:nodeId/chat', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const nodeId = c.req.param('nodeId');
  const body = planChatRequestSchema.parse(await c.req.json());
  const node = await requireNode(repositoryId, nodeId);
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);

  // The opening turn is recorded here rather than by the step: the step's detect
  // reads the transcript, so the message has to exist before the task starts.
  const db = getDb();
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'plan_chat',
    title: `Plan chat: ${node.title}`,
    description: body.message,
    metadata: { planNodeId: nodeId },
    cliProviderId,
    // The opening turn must be readable before the worker starts: detect()
    // derives the pending question from the transcript, and the step's skipIf
    // treats "no pending question" as nothing to answer. Inserting it after the
    // enqueue lost that race and parked the conversation on an empty form
    // without ever calling a CLI.
    seed: async (id) => {
      await db.insert(schema.planNodeMessages).values({
        nodeId,
        taskId: id,
        role: 'user',
        body: body.message,
      });
    },
  });
  return c.json({ taskId }, 201);
});

planRoutes.post('/:id/plan/nodes/:nodeId/advisory', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const nodeId = c.req.param('nodeId');
  const body = planAdvisoryRequestSchema.parse(await c.req.json().catch(() => ({})));
  const node = await requireNode(repositoryId, nodeId);
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'advisory',
    title: `Research: ${node.title}`,
    description: body.question,
    metadata: { planNodeId: nodeId },
    cliProviderId,
  });
  return c.json({ taskId }, 201);
});
