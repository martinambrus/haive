import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  HAIVE_DATA_FILES,
  PLAN_MERGE_MESSAGE_EVENT,
  TASK_JOB_NAMES,
  configService,
  createPlanEdgeRequestSchema,
  createPlanNodeRequestSchema,
  planAdvisoryRequestSchema,
  planBuildRequestSchema,
  planChatRequestSchema,
  planMergeStartRequestSchema,
  planSequenceRequestSchema,
  planSnapshotSaveRequestSchema,
  logger,
  updatePlanNodeRequestSchema,
  type PlanPatch,
} from '@haive/shared';
import {
  IMPACT_DEFAULT_VIEW_DEPTH,
  PlanPatchError,
  ancestryOf,
  applyPlanPatch,
  computeImpact,
  computePlanSequence,
  describePlanDefects,
  findPlanRoot,
  loadPlanEdges,
  loadPlanNode,
  loadPlanNodes,
  loadPlanSkeletons,
  loadPlanTouchedTasks,
  renderImpactMermaid,
  toEdgeViews,
  toNodeViews,
} from '@haive/shared/plan';
import { getDb } from '../db.js';
import { resolveRepoRoot } from './repos.js';
import { planDeleteRefusal } from '../lib/plan-delete-refusal.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { spawnPlanTask } from '../lib/spawn-plan-task.js';
import { enqueuePlanMirrorRefresh, pullPlanMirror, savePlanMirror } from '../lib/plan-mirror.js';
import { getTaskQueue } from '../queues.js';

const exec = promisify(execFile);

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

async function gitRead(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 5_000 });
    return { ok: true, stdout: stdout.toString().trim() };
  } catch (err) {
    const e = err as { stdout?: string };
    return { ok: false, stdout: (e.stdout ?? '').toString().trim() };
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Root plus its immediate children. The entry point the canvas loads first;
 *  descending fetches one level at a time, so nothing preloads the whole tree. */
planRoutes.get('/:id/plan', async (c) => {
  const { repositoryId, repo } = await requireOwnedRepo(c);
  const db = getDb();
  const [skeletons, edges, touched] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanEdges(db, repositoryId),
    loadPlanTouchedTasks(db, repositoryId),
  ]);
  const root = skeletons.find((n) => n.parentId === null) ?? null;
  if (!root) {
    return c.json({
      repositoryName: repo.name,
      root: null,
      children: [],
      nodeCount: 0,
      defects: { cycles: [], ancestorDeps: [] },
    });
  }
  const derived = computePlanSequence(skeletons, edges, touched);
  const children = skeletons.filter((n) => n.parentId === root.id);
  const bodies = new Map([
    [root.id, (await loadPlanNode(db, repositoryId, root.id))?.body ?? null],
  ]);
  return c.json({
    repositoryName: repo.name,
    root: toNodeViews([root], derived, bodies)[0],
    children: toNodeViews(children, derived),
    nodeCount: skeletons.length,
    // Dependency knots ride the overview because they are a property of the
    // PLAN, not of any one node: a cycle has two ends and neither is the place
    // to report it. MEASURED on the dev install, one 4106-node plan carries 5
    // dependency cycles and 11 dependencies on an own ancestor — all
    // permanently unsatisfiable, and none of them visible anywhere before this.
    defects: describePlanDefects(skeletons, edges, derived),
  });
});

/** The four boundaries a portable plan crosses: DB -> files -> commit -> remote. */
planRoutes.get('/:id/plan/snapshot', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  const db = getDb();
  const state = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, repositoryId),
  });
  const repoRoot = await resolveRepoRoot(db, userId, repositoryId).catch(() => null);
  const paths = [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown];
  const filesExist = repoRoot
    ? (
        await Promise.all(
          paths.map((rel) =>
            access(path.join(repoRoot, rel))
              .then(() => true)
              .catch(() => false),
          ),
        )
      ).every(Boolean)
    : false;

  let gitAvailable = false;
  let tracked = false;
  let uncommitted = false;
  let branch: string | null = null;
  let pushed: boolean | null = null;
  // Whether there is anywhere to push TO. Read from git rather than from
  // `repositories.remote_url`, because it is git that push and pull obey — a
  // column saying otherwise would offer the user a button that cannot work.
  let originUrl: string | null = null;
  if (repoRoot) {
    const inside = await gitRead(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    gitAvailable = inside.ok && inside.stdout === 'true';
    if (gitAvailable) {
      const origin = await gitRead(repoRoot, ['remote', 'get-url', 'origin']);
      originUrl = origin.ok ? origin.stdout || null : null;
      const [trackedResults, status, branchResult, upstream] = await Promise.all([
        Promise.all(
          paths.map((rel) => gitRead(repoRoot, ['ls-files', '--error-unmatch', '--', rel])),
        ),
        gitRead(repoRoot, ['status', '--porcelain', '--', ...paths]),
        gitRead(repoRoot, ['branch', '--show-current']),
        gitRead(repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']),
      ]);
      tracked = trackedResults.every((result) => result.ok);
      uncommitted = status.ok && status.stdout.length > 0;
      branch = branchResult.ok ? branchResult.stdout || null : null;
      if (tracked && !uncommitted && upstream.ok) {
        const ahead = await gitRead(repoRoot, ['rev-list', '--count', '@{upstream}..HEAD']);
        pushed = ahead.ok ? Number(ahead.stdout) === 0 : null;
      }
    }
  }

  const revision = state?.revision ?? 0;
  const writtenRevision = state?.writtenRevision ?? 0;
  return c.json({
    revision,
    writtenRevision,
    snapshotWritten: filesExist && revision > 0 && revision === writtenRevision,
    lastError: state?.lastError ?? null,
    filesExist,
    gitAvailable,
    tracked,
    uncommitted,
    committed: filesExist && tracked && !uncommitted,
    pushed,
    branch,
    hasOrigin: originUrl !== null,
    originUrl,
  });
});

/** Task states that mean a merge conversation is still the user's to finish. */
const OPEN_MERGE_STATES = ['created', 'queued', 'running', 'paused', 'waiting_user'] as const;

async function findOpenPlanMerge(repositoryId: string) {
  return getDb().query.tasks.findFirst({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      eq(schema.tasks.type, 'plan_merge'),
      inArray(schema.tasks.status, [...OPEN_MERGE_STATES]),
    ),
    columns: { id: true, status: true, cliProviderId: true, createdAt: true },
  });
}

async function refuseWhileMergeOpen(repositoryId: string): Promise<void> {
  const open = await findOpenPlanMerge(repositoryId);
  if (open) {
    throw new HttpError(
      409,
      'A merge conversation is open for this repository — finish or discard it first',
      'plan_merge_open',
    );
  }
}

planRoutes.post('/:id/plan/snapshot/save', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = planSnapshotSaveRequestSchema.parse(await c.req.json().catch(() => ({})));
  // A merge conversation owns the scratch worktree and is the thing that will land
  // the remote; saving underneath it would race its checkout.
  await refuseWhileMergeOpen(repositoryId);
  try {
    return c.json(
      await savePlanMirror({
        repositoryId,
        userId,
        push: body.push,
        ...(body.commitMessage ? { commitMessage: body.commitMessage } : {}),
      }),
    );
  } catch (err) {
    throw new HttpError(
      409,
      err instanceof Error ? err.message : 'Could not save the plan snapshot',
      'plan_snapshot_save_failed',
    );
  }
});

/** The one direction that reads the repository into the database: fast-forward
 *  the checkout, then reconcile the committed snapshot onto the local plan.
 *
 *  Additive — a node that exists only here is KEPT and reported, never deleted,
 *  because "someone added it locally" and "the other side removed it" look
 *  identical from the snapshot and only one of those is reversible. */
planRoutes.post('/:id/plan/snapshot/pull', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  await refuseWhileMergeOpen(repositoryId);
  try {
    return c.json(await pullPlanMirror({ repositoryId, userId }));
  } catch (err) {
    throw new HttpError(
      409,
      err instanceof Error ? err.message : 'Could not pull the plan snapshot',
      'plan_snapshot_pull_failed',
    );
  }
});

/** Hierarchy only — id, title, status, parentage. Feeds the tree view, which the
 *  user asked to show no edges. */
planRoutes.get('/:id/plan/tree', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const db = getDb();
  // This route deliberately served no edges: the tree shows hierarchy only. It
  // has to load them now, because whether a node is blocked is a function of
  // them — one indexed query against the biggest payload, rather than a tree
  // that renders every node as ready.
  const [skeletons, edges, touched] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanEdges(db, repositoryId),
    loadPlanTouchedTasks(db, repositoryId),
  ]);
  const derived = computePlanSequence(skeletons, edges, touched);
  return c.json({
    nodes: toNodeViews(skeletons, derived).map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      kind: n.kind,
      status: n.status,
      rolledStatus: n.rolledStatus,
      taskable: n.taskable,
      directChildren: n.directChildren,
      totalDescendants: n.totalDescendants,
      sequence: n.sequence,
      // The count, not the blockers: this payload is the WHOLE plan (2743 nodes
      // on the dev install) and the detail read already carries the list for
      // the one node a person is looking at.
      blockedCount: n.blockedBy.length,
      driftedTasks: n.driftedTasks,
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
  const [skeletons, nodes, edges, touched] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanNodes(db, repositoryId),
    loadPlanEdges(db, repositoryId),
    loadPlanTouchedTasks(db, repositoryId),
  ]);
  const bodyById = new Map(nodes.map((n) => [n.id, n.body ?? '']));
  const hits = skeletons.filter(
    (n) => n.title.toLowerCase().includes(q) || bodyById.get(n.id)!.toLowerCase().includes(q),
  );
  // The breadcrumb ships with each hit so the UI can jump straight to a match at
  // depth 6 without walking the tree a level at a time to get there.
  return c.json({
    matches: toNodeViews(hits, computePlanSequence(skeletons, edges, touched)).map((n) => ({
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
  const [skeletons, edges, touched] = await Promise.all([
    loadPlanSkeletons(db, repositoryId),
    loadPlanEdges(db, repositoryId),
    loadPlanTouchedTasks(db, repositoryId),
  ]);
  const children = skeletons.filter((n) => n.parentId === nodeId);
  const derived = computePlanSequence(skeletons, edges, touched);
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
    node: toNodeViews([node], derived, new Map([[node.id, node.body]]))[0],
    ancestry: ancestryOf(skeletons, nodeId).map((a) => ({ id: a.id, title: a.title })),
    children: toNodeViews(children, derived),
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
  // Absent means the VIEW's default radius, not the walk's safety cap. One hop
  // reaches a median of 3 nodes on a real plan and two reach 130 — a transitive
  // answer is "essentially the whole plan", which answers nothing. Deeper is
  // available, but asked for.
  const depthParam = Number(c.req.query('maxDepth'));
  const impact = computeImpact(nodeId, edges, {
    maxDepth:
      Number.isFinite(depthParam) && depthParam > 0 ? depthParam : IMPACT_DEFAULT_VIEW_DEPTH,
  });
  const titleById = new Map(skeletons.map((n) => [n.id, n.title]));
  const byId = new Map(skeletons.map((n) => [n.id, n]));

  const diagram = renderImpactMermaid(impact, titleById);

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
    mermaid: diagram.source,
    // What the picture had to leave out, so the panel can say so rather than
    // letting a bounded diagram read as the whole answer.
    mermaidOmitted: diagram.omitted,
    codeLinks: codeLinks.filter((l) => l.nodeId === nodeId || affectedIds.includes(l.nodeId)),
  });
});

/* ------------------------------------------------------------------ */
/* Writes — all through applyPlanPatch                                 */
/* ------------------------------------------------------------------ */

planRoutes.post('/:id/plan/nodes', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
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
    await enqueuePlanMirrorRefresh(repositoryId, userId);
    return c.json({ node: await loadPlanNode(db, repositoryId, created) }, 201);
  } catch (err) {
    planError(err);
  }
});

planRoutes.patch('/:id/plan/nodes/:nodeId', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
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
    await enqueuePlanMirrorRefresh(repositoryId, userId);
    return c.json({ node: await loadPlanNode(db, repositoryId, nodeId) });
  } catch (err) {
    planError(err);
  }
});

/**
 * Delete the whole plan for a repository.
 *
 * Destructive and effectively irreversible: every node, edge, code link, chat
 * transcript and read marker goes with it. The one recovery path is the
 * COMMITTED `.haive-data/plan.json` — `importPlanMirror` recreates nodes with
 * their original ids on a fresh clone — which is why the mirror is removed here
 * too, and why a failure to remove it is reported rather than swallowed.
 *
 * PLAN_CANVAS_ENABLED is deliberately NOT consulted. That switch refuses NEW
 * plan work while leaving existing plans readable and editable; removing one a
 * user no longer wants is the most editable thing there is, and refusing here
 * would strand a plan the user cannot get rid of.
 */
planRoutes.delete('/:id/plan', async (c) => {
  const { userId, repositoryId, repo } = await requireOwnedRepo(c);
  const db = getDb();

  const openTasks = await db
    .select({ id: schema.tasks.id, title: schema.tasks.title, type: schema.tasks.type })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        inArray(schema.tasks.type, ['plan_build', 'plan_chat', 'advisory']),
        notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
      ),
    );

  const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
  const refusal = planDeleteRefusal({
    confirm: body.confirm,
    repoName: repo.name,
    openTasks,
  });
  if (refusal) {
    return c.json(
      {
        error: refusal.message,
        code: refusal.code,
        ...(refusal.tasks ? { tasks: refusal.tasks } : {}),
      },
      refusal.status,
    );
  }

  const root = await findPlanRoot(db, repositoryId);
  if (!root) return c.json({ deletedNodes: 0, mirrorRemoved: true });

  // Through applyPlanPatch like every other write; the subtree goes by the
  // parent_id cascade. No expectedVersion: the user is deleting the whole
  // plan, so a concurrent edit to one node does not change their intent, and a
  // 409 here would be noise on the one action nobody wants to retry.
  const result = await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: root.id }] },
    { repositoryId, origin: 'user' },
  );
  await enqueuePlanMirrorRefresh(repositoryId, userId);

  // Mirror second: the database is the source of truth and these files are
  // derived from it. A file that is already gone is success. A file that
  // cannot be removed is REPORTED — it is the path by which a deleted plan
  // comes back on the next clone.
  let mirrorRemoved = true;
  try {
    const repoRoot = await resolveRepoRoot(db, userId, repositoryId);
    for (const rel of [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown]) {
      await rm(path.join(repoRoot, rel), { force: true });
    }
  } catch (err) {
    mirrorRemoved = false;
    logger.warn({ err, repositoryId }, 'plan mirror removal failed after plan delete');
  }

  return c.json({ deletedNodes: result.deleted.length, mirrorRemoved });
});

planRoutes.delete('/:id/plan/nodes/:nodeId', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
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
    await enqueuePlanMirrorRefresh(repositoryId, userId);
    return c.json({ deleted: res.deleted });
  } catch (err) {
    planError(err);
  }
});

planRoutes.post('/:id/plan/edges', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
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
    await enqueuePlanMirrorRefresh(repositoryId, userId);
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
  const { userId, repositoryId } = await requireOwnedRepo(c);
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
    await enqueuePlanMirrorRefresh(repositoryId, userId);
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
  // A deferred start exists to let attachments land first, and they land in the
  // repo's uploads dir — the same requirement the attachments route enforces,
  // checked here so the user is told before a task is created rather than after
  // the first upload 409s.
  if (body.deferStart && !repo.storagePath) {
    throw new HttpError(409, 'This repository is not ready for uploads yet');
  }
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'plan_build',
    title: body.title?.trim() || `Build plan: ${repo.name}`,
    description: body.description,
    // `planBuildDeferred` records HOW the task was created and never changes;
    // whether it has since started is `tasks.status`, which is the column that
    // actually proves it. The UI's Start affordance keys on the status.
    metadata: {
      planBuildMode: body.mode,
      ...(body.deferStart ? { planBuildDeferred: true } : {}),
    },
    cliProviderId,
    // Uploads cannot ride a seed hook: the api does not know how many files are
    // coming or whether they all arrive. So the row is created unstarted and the
    // client finalizes with the `start` action once every upload succeeds —
    // which keeps the invariant the seed hook existed for (the files are on disk
    // before the worker's first detect) without pretending to own the transfer.
    ...(body.deferStart ? { enqueue: false } : {}),
  });
  return c.json({ taskId, deferred: body.deferStart === true }, 201);
});

/** Order an existing plan. Its own endpoint for the same reason the other plan
 *  task types have theirs: it needs a repository the generic create-task form
 *  has no field for. */
planRoutes.post('/:id/plan/sequence', async (c) => {
  const { userId, repositoryId, repo } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = planSequenceRequestSchema.parse(await c.req.json().catch(() => ({})));
  const root = await findPlanRoot(getDb(), repositoryId);
  if (!root) throw new HttpError(409, 'This repository has no plan to order yet');
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'plan_sequence',
    title: `Order plan: ${repo.name}`,
    metadata: {},
    cliProviderId,
  });
  return c.json({ taskId }, 201);
});

/**
 * Resolve a conflicted pull, as a conversation.
 *
 * Only reached when save/pull could not integrate the remote themselves — they merge
 * whatever they can, and auto-resolve the mirror's own two files, so what is left
 * here is a genuine two-sided decision.
 */
planRoutes.post('/:id/plan/merge', async (c) => {
  const { userId, repositoryId, repo } = await requireOwnedRepo(c);
  await requirePlanCanvasEnabled();
  const body = planMergeStartRequestSchema.parse(await c.req.json().catch(() => ({})));
  const existing = await findOpenPlanMerge(repositoryId);
  // One live merge worktree per repository. A second conversation would build its
  // own on top of the first one's and neither could land.
  if (existing) {
    throw new HttpError(
      409,
      'A merge conversation is already open for this repository',
      'plan_merge_open',
    );
  }
  const cliProviderId = await resolveProvider(userId, repositoryId, body.cliProviderId);
  const taskId = await spawnPlanTask({
    userId,
    repositoryId,
    type: 'plan_merge',
    title: `Resolve plan merge: ${repo.name}`,
    metadata: {},
    cliProviderId,
  });
  return c.json({ taskId }, 201);
});

/** The open merge conversation, if there is one — the banner and the panel both
 *  read this. Returns `{ merge: null }` rather than 404 so the plan page can poll it
 *  as a plain state read. */
planRoutes.get('/:id/plan/merge', async (c) => {
  const { repositoryId } = await requireOwnedRepo(c);
  const task = await findOpenPlanMerge(repositoryId);
  if (!task) return c.json({ merge: null });
  const rows = await getDb()
    .select({ payload: schema.taskEvents.payload, createdAt: schema.taskEvents.createdAt })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, task.id),
        eq(schema.taskEvents.eventType, PLAN_MERGE_MESSAGE_EVENT),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  return c.json({
    merge: {
      taskId: task.id,
      status: task.status,
      cliProviderId: task.cliProviderId,
      createdAt: task.createdAt,
      messages: rows.map((r, i) => {
        const p = (r.payload ?? {}) as { role?: string; body?: string };
        return {
          id: `${task.id}:${i}`,
          role: p.role === 'user' ? 'user' : 'assistant',
          body: p.body ?? '',
          createdAt: r.createdAt,
        };
      }),
    },
  });
});

/** Abandon it. Cancels the task and removes the scratch worktree — the checkout has
 *  not moved, so there is nothing else to undo. */
planRoutes.delete('/:id/plan/merge', async (c) => {
  const { userId, repositoryId } = await requireOwnedRepo(c);
  const task = await findOpenPlanMerge(repositoryId);
  if (!task) return c.json({ ok: true, cancelled: false });
  await getTaskQueue().add(
    TASK_JOB_NAMES.CANCEL,
    { taskId: task.id, userId },
    {
      removeOnComplete: true,
    },
  );
  return c.json({ ok: true, cancelled: true, taskId: task.id });
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
