/**
 * Integration smoke for the plan canvas persistence layer against a real Postgres.
 *
 * The unit tests in `shared/src/plan/paths.test.ts` cover the path arithmetic in
 * isolation; what they cannot cover is the part that only exists in the database:
 * a patch is ONE transaction, `path` is rewritten for every descendant of a moved
 * subtree by a SQL substring, a delete cascades through a self-FK, and
 * `expectedVersion` has to lose a race with a concurrent write. The second half
 * covers the `.haive-data/` mirror, whose whole job is to restore the portable
 * plan model onto a fresh clone.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
// Subpath, not the root barrel: the plan applier reaches the database, and the
// barrel is what pulls ioredis/dns into anything that imports it.
import {
  PlanPatchError,
  applyPlanPatch,
  computePlanSequence,
  findPlanRoot,
  loadPlanEdges,
  loadPlanNodes,
  loadPlanSkeletons,
  renderPlanMarkdownFrom,
  toNodeViews,
} from '@haive/shared/plan';
import { markPlanCodeLinksStale } from '../src/plan/code-link-staleness.js';
import { HAIVE_DATA_FILES, PLAN_MIRROR_SCHEMA_VERSION, type PlanMirror } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { importPlanMirror, reconcilePlanMirror, writePlanMirror } from '../src/plan/mirror.js';
import { completePlanNodesForTask } from '../src/plan/task-link.js';

const log = logger.child({ module: 'plan-patch-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

const failures: string[] = [];

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    log.info({ label }, 'ok');
    return;
  }
  failures.push(label);
  log.error({ label, detail }, 'FAILED');
}

async function expectPatchError(
  label: string,
  kind: PlanPatchError['kind'],
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    check(label, false, 'no error thrown');
  } catch (err) {
    const ok = err instanceof PlanPatchError && err.kind === kind;
    check(label, ok, err instanceof Error ? `${err.name}: ${err.message}` : err);
  }
}

interface State {
  userId?: string;
  repoId?: string;
  mirrorRepoId?: string;
  taskId?: string;
  tmpDir?: string;
}
const state: State = {};

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const now = new Date();

  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'plan-smoke@test.local',
    emailBlindIndex: `plan-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  state.userId = userId;

  const [repo] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: 'plan-smoke-fixture',
      source: 'blank',
      status: 'ready',
    })
    .returning();
  if (!repo) throw new Error('repo insert failed');
  state.repoId = repo.id;
  const repositoryId = repo.id;

  const [linkTask] = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: 'workflow',
      title: 'plan-smoke staleness fixture',
      repositoryId,
      status: 'completed',
    })
    .returning();
  const linkTaskId = linkTask!.id;
  state.taskId = linkTaskId;

  const nodes = async () =>
    db
      .select({
        id: schema.planNodes.id,
        parentId: schema.planNodes.parentId,
        path: schema.planNodes.path,
        title: schema.planNodes.title,
        version: schema.planNodes.version,
      })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repositoryId))
      .orderBy(asc(schema.planNodes.path));
  const byTitle = async (title: string) => (await nodes()).find((n) => n.title === title);

  /* --- 1. one turn creates a subtree and links into it via temp refs ------- */

  const built = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Product' },
        { op: 'upsert', nodeRef: 'api', parentRef: 'root', title: 'API' },
        { op: 'upsert', nodeRef: 'web', parentRef: 'root', title: 'Web' },
        { op: 'upsert', nodeRef: 'auth', parentRef: 'api', title: 'Auth' },
        { op: 'upsert', nodeRef: 'login', parentRef: 'auth', title: 'Login form' },
        { op: 'link', fromRef: 'web', toRef: 'auth', kind: 'depends_on' },
      ],
    },
    { repositoryId, origin: 'llm' },
  );
  check('temp refs create the whole subtree in one patch', built.created.length === 5, built);
  check('link resolved both temp refs', built.linked === 1, built);
  check('refs map every temp id to a uuid', Object.keys(built.refs).length === 5, built.refs);

  const root = await findPlanRoot(db, repositoryId);
  check('findPlanRoot returns the root', root?.title === 'Product', root);

  const login = await byTitle('Login form');
  const auth = await byTitle('Auth');
  const api = await byTitle('API');
  const web = await byTitle('Web');
  check(
    'path is the full self-inclusive ancestry',
    login?.path === `/${root!.id}/${api!.id}/${auth!.id}/${login!.id}/`,
    login?.path,
  );

  /* --- 2. a second root is refused ---------------------------------------- */

  await expectPatchError('a second plan root is refused', 'invalid', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: 'root2', parentRef: null, title: 'Other product' }] },
      { repositoryId, origin: 'user' },
    ),
  );

  /* --- 3. expectedVersion loses to a concurrent write --------------------- */

  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: auth!.id, title: 'Auth (renamed)', expectedVersion: 1 }] },
    { repositoryId, origin: 'user' },
  );
  const bumped = await byTitle('Auth (renamed)');
  check('a successful write bumps version', bumped?.version === 2, bumped);

  await expectPatchError('a stale expectedVersion is a conflict', 'conflict', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: auth!.id, title: 'Auth (racer)', expectedVersion: 1 }] },
      { repositoryId, origin: 'user' },
    ),
  );
  check(
    'the losing write changed nothing',
    (await byTitle('Auth (renamed)')) !== undefined &&
      (await byTitle('Auth (racer)')) === undefined,
  );

  /* --- 4. a subtree move rewrites every descendant path -------------------- */

  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: auth!.id, parentRef: web!.id }] },
    { repositoryId, origin: 'user' },
  );
  const movedAuth = await byTitle('Auth (renamed)');
  const movedLogin = await byTitle('Login form');
  check(
    'the moved node re-roots under its new parent',
    movedAuth?.path === `/${root!.id}/${web!.id}/${auth!.id}/`,
    movedAuth?.path,
  );
  check(
    'every DESCENDANT of the moved node is rewritten too',
    movedLogin?.path === `/${root!.id}/${web!.id}/${auth!.id}/${login!.id}/`,
    movedLogin?.path,
  );
  check('the moved node keeps its id', movedAuth?.id === auth!.id);
  check('the descendant keeps its id', movedLogin?.id === login!.id);

  /* --- 5. a move under one's own descendant is refused --------------------- */

  await expectPatchError('a move under a descendant is refused', 'invalid', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: auth!.id, parentRef: login!.id }] },
      { repositoryId, origin: 'user' },
    ),
  );
  check(
    'the refused move left the tree untouched',
    (await byTitle('Auth (renamed)'))?.path === movedAuth?.path,
  );

  /* --- 5.5 an unsatisfiable depends_on is refused at the WRITE ------------- */

  // These were being MINTED by the build agents: one 4106-node plan on the dev
  // install held 5 dependency cycles and 11 nodes depending on an own ancestor,
  // every one of them permanently blocking whatever sat on it. Telling a model
  // not to do something is a hope, not a constraint, so the applier refuses.
  await expectPatchError('a dependency on an own ancestor is refused', 'invalid', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'link', fromRef: login!.id, toRef: auth!.id, kind: 'depends_on' }] },
      { repositoryId, origin: 'user' },
    ),
  );

  // The other direction is redundant, not impossible — the roll-up already says
  // a container waits for its children — and refusing satisfiable-but-redundant
  // is how a guard starts rejecting things people meant.
  await applyPlanPatch(
    db,
    { ops: [{ op: 'link', fromRef: auth!.id, toRef: login!.id, kind: 'depends_on' }] },
    { repositoryId, origin: 'user' },
  );
  check(
    'a dependency on an own DESCENDANT is allowed',
    (await loadPlanEdges(db, repositoryId)).some(
      (e) => e.fromNodeId === auth!.id && e.toNodeId === login!.id && e.kind === 'depends_on',
    ),
  );

  await expectPatchError('a dependency closing a loop is refused', 'invalid', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'link', fromRef: login!.id, toRef: auth!.id, kind: 'depends_on' }] },
      { repositoryId, origin: 'user' },
    ),
  );

  // `affects` and `implements` cycle by construction — two components that each
  // affect the other is a normal thing for a plan to say. Only the kind that
  // HOLDS WORK BACK is constrained.
  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'link', fromRef: login!.id, toRef: auth!.id, kind: 'affects' },
        { op: 'link', fromRef: auth!.id, toRef: login!.id, kind: 'affects' },
      ],
    },
    { repositoryId, origin: 'user' },
  );
  check(
    'affects may still cycle',
    (await loadPlanEdges(db, repositoryId)).filter((e) => e.kind === 'affects').length >= 2,
  );

  // An AGENT loses the impossible link, not the rest of its reply — the same
  // policy an unresolvable ref gets, for the same reason.
  const agentPatch = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'kept', parentRef: root!.id, title: 'Survives the bad link' },
        { op: 'link', fromRef: login!.id, toRef: auth!.id, kind: 'depends_on' },
      ],
    },
    { repositoryId, origin: 'llm', onUnresolvableRef: 'drop' },
  );
  check(
    'an agent keeps its work and loses only the impossible link',
    agentPatch.created.length === 1 && agentPatch.dropped.length === 1,
    agentPatch,
  );
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: agentPatch.created[0]! }] },
    { repositoryId, origin: 'user' },
  );
  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'unlink', fromRef: auth!.id, toRef: login!.id, kind: 'depends_on' },
        { op: 'unlink', fromRef: login!.id, toRef: auth!.id, kind: 'affects' },
        { op: 'unlink', fromRef: auth!.id, toRef: login!.id, kind: 'affects' },
      ],
    },
    { repositoryId, origin: 'user' },
  );

  /* --- 6. a failing op rolls the WHOLE patch back -------------------------- */

  const beforeCount = (await nodes()).length;
  await expectPatchError('a patch with one bad op fails entirely', 'invalid', () =>
    applyPlanPatch(
      db,
      {
        ops: [
          { op: 'upsert', nodeRef: 'ghost', parentRef: root!.id, title: 'Should not survive' },
          { op: 'link', fromRef: 'ghost', toRef: 'nowhere', kind: 'affects' },
        ],
      },
      { repositoryId, origin: 'llm' },
    ),
  );
  check(
    'the earlier op in the failed patch was rolled back',
    (await nodes()).length === beforeCount && (await byTitle('Should not survive')) === undefined,
  );

  /* --- 7. delete cascades through the subtree ------------------------------ */

  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: auth!.id }] },
    { repositoryId, origin: 'user' },
  );
  const after = await nodes();
  check(
    'deleting a node deletes its descendants',
    after.length === 3 && !after.some((n) => n.id === login!.id),
    after.map((n) => n.title),
  );
  const edges = await db
    .select({ id: schema.planNodeEdges.id })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, repositoryId));
  check('edges to a deleted node go with it', edges.length === 0, edges);

  /* --- 8. a stale uuid is not silently re-created -------------------------- */

  await expectPatchError('an upsert naming a deleted node is not_found', 'not_found', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: login!.id, title: 'Resurrected' }] },
      { repositoryId, origin: 'llm' },
    ),
  );

  /* --- 9. a patch cannot reach into another repository --------------------- */

  const [otherRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-smoke-other', source: 'blank', status: 'ready' })
    .returning();
  await expectPatchError('a node from another repo is not visible', 'not_found', () =>
    applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: root!.id, title: 'cross-repo write' }] },
      { repositoryId: otherRepo!.id, origin: 'user' },
    ),
  );
  await db.delete(schema.repositories).where(eq(schema.repositories.id, otherRepo!.id));

  /* --- 10. ordinals append rather than collide ----------------------------- */

  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'ops', parentRef: root!.id, title: 'Ops' },
        { op: 'upsert', nodeRef: 'legal', parentRef: root!.id, title: 'Legal', kind: 'external' },
      ],
    },
    { repositoryId, origin: 'user' },
  );
  const siblings = await db
    .select({ title: schema.planNodes.title, ordinal: schema.planNodes.ordinal })
    .from(schema.planNodes)
    .where(
      and(eq(schema.planNodes.repositoryId, repositoryId), eq(schema.planNodes.parentId, root!.id)),
    )
    .orderBy(asc(schema.planNodes.ordinal));
  check(
    'new siblings append to distinct ordinals',
    new Set(siblings.map((s) => s.ordinal)).size === siblings.length,
    siblings,
  );

  /* --- 11. code links, and what makes one stale ---------------------------- */

  const linkTarget = await byTitle('Web');
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          codeLinks: [
            { repoPath: 'src/mobile/App.tsx', evidence: 'the app shell', confidence: 0.9 },
            { repoPath: 'src/mobile/App.tsx', symbol: 'useSession', evidence: 'reads the token' },
          ],
        },
      ],
    },
    { repositoryId, origin: 'llm', derivedAtCommit: 'abc123' },
  );
  const readLinks = async () =>
    db
      .select({
        id: schema.planNodeCodeLinks.id,
        repoPath: schema.planNodeCodeLinks.repoPath,
        symbol: schema.planNodeCodeLinks.symbol,
        stale: schema.planNodeCodeLinks.stale,
        commit: schema.planNodeCodeLinks.derivedAtCommit,
      })
      .from(schema.planNodeCodeLinks)
      .where(eq(schema.planNodeCodeLinks.nodeId, linkTarget!.id));

  let links = await readLinks();
  check('code links are written with their commit', links.length === 2, links);
  check(
    'a file-level link and a symbol-level one on the same file coexist',
    links.filter((l) => l.repoPath === 'src/mobile/App.tsx').length === 2,
    links,
  );

  // The bug the coalesce(symbol,'') index exists for: a NULL symbol is DISTINCT
  // in a plain unique index, so re-asserting a file-level link would duplicate it.
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          codeLinks: [{ repoPath: 'src/mobile/App.tsx', evidence: 'still the app shell' }],
        },
      ],
    },
    { repositoryId, origin: 'llm', derivedAtCommit: 'def456' },
  );
  links = await readLinks();
  check('re-asserting a file-level link updates rather than duplicates', links.length === 2, links);

  const beforeStale = await db
    .update(schema.tasks)
    .set({ changedPaths: ['src/mobile/App.tsx'] })
    .where(eq(schema.tasks.id, linkTaskId))
    .returning({ id: schema.tasks.id });
  check('staleness fixture task exists', beforeStale.length === 1);

  const staleResult = await markPlanCodeLinksStale(db, linkTaskId);
  links = await readLinks();
  check(
    'a task that changed the file marks its links stale',
    staleResult.marked === 2 && links.every((l) => l.stale),
    { staleResult, links },
  );
  check(
    'marking is idempotent — an already-stale link is not rewritten',
    (await markPlanCodeLinksStale(db, linkTaskId)).marked === 0,
  );

  // Re-assertion is the ONLY thing that clears the flag: an agent has just opened
  // the file and said it still belongs, which is the fresh evidence the flag was
  // waiting for.
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          codeLinks: [{ repoPath: 'src/mobile/App.tsx', evidence: 're-checked' }],
        },
      ],
    },
    { repositoryId, origin: 'llm', derivedAtCommit: 'ghi789' },
  );
  links = await readLinks();
  const reasserted = links.find((l) => l.symbol === null);
  const untouched = links.find((l) => l.symbol === 'useSession');
  check('re-asserting a link clears its stale flag', reasserted?.stale === false, reasserted);
  check('a link nobody re-asserted stays stale', untouched?.stale === true, untouched);

  /* --- 12. the .haive-data mirror round-trips onto a fresh clone ----------- */

  const opsNode = await byTitle('Ops');
  const legalNode = await byTitle('Legal');
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          body: 'The customer-facing application shell.',
          status: 'in_progress',
          taskable: true,
        },
        {
          op: 'upsert',
          nodeRef: opsNode!.id,
          body: 'Deployment and runtime operations.',
          status: 'done',
        },
        {
          op: 'upsert',
          nodeRef: legalNode!.id,
          body: 'External approval required.',
          status: 'blocked_human',
        },
        {
          op: 'upsert',
          nodeRef: 'portable-decision',
          parentRef: root!.id,
          title: 'Architecture decision',
          kind: 'decision',
          body: 'The decision has been superseded.',
          status: 'not_applicable',
          // Deliberate collision with an existing sibling: the snapshot must
          // preserve display order without exporting createdAt as a tie-breaker.
          ordinal: 0,
        },
        {
          op: 'upsert',
          nodeRef: 'portable-research',
          parentRef: root!.id,
          title: 'Market research',
          kind: 'research',
          body: 'Research still to do.',
          status: 'todo',
        },
        {
          op: 'link',
          fromRef: linkTarget!.id,
          toRef: opsNode!.id,
          kind: 'depends_on',
          note: 'Deployment must exist before the application ships.',
        },
        {
          op: 'link',
          fromRef: legalNode!.id,
          toRef: linkTarget!.id,
          kind: 'affects',
          note: 'Approval affects the application release.',
        },
        {
          op: 'link',
          fromRef: opsNode!.id,
          toRef: api!.id,
          kind: 'implements',
          note: 'Operations implements the API deployment.',
        },
      ],
    },
    { repositoryId, origin: 'user', sourceTaskId: linkTaskId },
  );

  // These rows are deliberately present when the mirror is written. They are
  // useful local construction/audit state, but they must not travel to a fresh
  // machine with the plan product state.
  await db.insert(schema.planNodeMessages).values({
    nodeId: linkTarget!.id,
    taskId: linkTaskId,
    role: 'assistant',
    body: 'transient plan-building conversation',
  });
  await db.insert(schema.planNodeTasks).values({ nodeId: linkTarget!.id, taskId: linkTaskId });
  await db
    .insert(schema.userPlanNodeReads)
    .values({ userId, nodeId: linkTarget!.id, lastReadAt: new Date() });

  const dirtyMirrorState = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, repositoryId),
  });
  check(
    'portable mutations leave a durable dirty mirror revision',
    !!dirtyMirrorState && dirtyMirrorState.revision > dirtyMirrorState.writtenRevision,
    dirtyMirrorState,
  );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'plan-mirror-'));
  state.tmpDir = tmpDir;
  const written = await writePlanMirror(db, repositoryId, tmpDir);
  check(
    'writePlanMirror writes both files',
    written.includes(HAIVE_DATA_FILES.plan) && written.includes(HAIVE_DATA_FILES.planMarkdown),
    written,
  );
  const writtenMirrorState = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, repositoryId),
  });
  check(
    'a successful projection catches written revision up to DB revision',
    !!writtenMirrorState && writtenMirrorState.revision === writtenMirrorState.writtenRevision,
    writtenMirrorState,
  );

  const mirrorRaw = await readFile(path.join(tmpDir, HAIVE_DATA_FILES.plan), 'utf8');
  const mirror = JSON.parse(mirrorRaw) as PlanMirror;
  const sourceNodes = await nodes();
  const sourcePlanRecords = await loadPlanNodes(db, repositoryId);
  const nextPortableOrdinal = new Map<string, number>();
  const sourcePortableNodes = sourcePlanRecords.map((node) => {
    const parentKey = node.parentId ?? '<root>';
    const ordinal = nextPortableOrdinal.get(parentKey) ?? 0;
    nextPortableOrdinal.set(parentKey, ordinal + 1);
    return {
      id: node.id,
      parentId: node.parentId,
      ordinal,
      title: node.title,
      kind: node.kind,
      body: node.body,
      status: node.status,
      taskable: node.taskable,
    };
  });
  const sourceEdges = await db
    .select({
      fromNodeId: schema.planNodeEdges.fromNodeId,
      toNodeId: schema.planNodeEdges.toNodeId,
      kind: schema.planNodeEdges.kind,
      note: schema.planNodeEdges.note,
    })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, repositoryId));
  const sourceCodeLinks = await db
    .select({
      nodeId: schema.planNodeCodeLinks.nodeId,
      repoPath: schema.planNodeCodeLinks.repoPath,
      symbol: schema.planNodeCodeLinks.symbol,
      evidence: schema.planNodeCodeLinks.evidence,
      derivedAtCommit: schema.planNodeCodeLinks.derivedAtCommit,
      stale: schema.planNodeCodeLinks.stale,
    })
    .from(schema.planNodeCodeLinks)
    .where(eq(schema.planNodeCodeLinks.repositoryId, repositoryId));
  const sourceSkeletons = await loadPlanSkeletons(db, repositoryId);
  const sourceBadges = toNodeViews(
    sourceSkeletons,
    computePlanSequence(sourceSkeletons, await loadPlanEdges(db, repositoryId)),
  )
    .map((node) => ({
      title: node.title,
      rolledStatus: node.rolledStatus,
      directChildren: node.directChildren,
      totalDescendants: node.totalDescendants,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  check('the mirror carries every node', mirror.nodes.length === sourceNodes.length, {
    mirror: mirror.nodes.length,
    db: sourceNodes.length,
  });
  check(
    'the mirror carries titles, descriptions, badges and statuses',
    JSON.stringify([...mirror.nodes].sort((a, b) => a.id.localeCompare(b.id))) ===
      JSON.stringify([...sourcePortableNodes].sort((a, b) => a.id.localeCompare(b.id))),
    mirror.nodes,
  );
  check(
    'the mirror carries typed plan links and their descriptions',
    JSON.stringify([...mirror.edges].sort((a, b) => a.fromNodeId.localeCompare(b.fromNodeId))) ===
      JSON.stringify([...sourceEdges].sort((a, b) => a.fromNodeId.localeCompare(b.fromNodeId))),
    mirror.edges,
  );
  check(
    'the mirror carries code-link evidence and staleness',
    JSON.stringify(
      [...mirror.codeLinks].sort((a, b) =>
        `${a.nodeId}:${a.repoPath}:${a.symbol ?? ''}`.localeCompare(
          `${b.nodeId}:${b.repoPath}:${b.symbol ?? ''}`,
        ),
      ),
    ) ===
      JSON.stringify(
        [...sourceCodeLinks].sort((a, b) =>
          `${a.nodeId}:${a.repoPath}:${a.symbol ?? ''}`.localeCompare(
            `${b.nodeId}:${b.repoPath}:${b.symbol ?? ''}`,
          ),
        ),
      ),
    mirror.codeLinks,
  );
  const mirrorRecord = JSON.parse(mirrorRaw) as Record<string, unknown>;
  const firstMirrorNode = mirror.nodes[0] as unknown as Record<string, unknown>;
  const firstMirrorCodeLink = mirror.codeLinks[0] as unknown as Record<string, unknown>;
  check(
    'the mirror excludes chat, tasks, read state and node construction metadata',
    !('messages' in mirrorRecord) &&
      !('tasks' in mirrorRecord) &&
      !('reads' in mirrorRecord) &&
      !('version' in firstMirrorNode) &&
      !('createdBy' in firstMirrorNode) &&
      !('sourceTaskId' in firstMirrorNode) &&
      !('confidence' in firstMirrorCodeLink),
    mirrorRecord,
  );

  const markdown = await readFile(path.join(tmpDir, HAIVE_DATA_FILES.planMarkdown), 'utf8');
  check(
    'plan.md stamps every node with a quotable id',
    sourceNodes.every((n) => markdown.includes(`node:${n.id}`)),
  );

  // Restoring into a repository that already has a plan must be a no-op.
  const noop = await importPlanMirror(db, repositoryId, tmpDir);
  check('import into a repo that already has a plan does nothing', noop.imported === false, noop);

  // A schemaVersion the reader does not know is ignored, not mis-parsed.
  const bumpedDir = await mkdtemp(path.join(os.tmpdir(), 'plan-mirror-v'));
  await mkdir(path.join(bumpedDir, '.haive-data'), { recursive: true });
  await writeFile(
    path.join(bumpedDir, HAIVE_DATA_FILES.plan),
    JSON.stringify({ ...mirror, schemaVersion: PLAN_MIRROR_SCHEMA_VERSION + 1 }),
    'utf8',
  );
  const [freshRepoA] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-smoke-vbump', source: 'blank', status: 'ready' })
    .returning();
  const rejected = await importPlanMirror(db, freshRepoA!.id, bumpedDir);
  check('a future schemaVersion imports nothing', rejected.imported === false, rejected);

  await writeFile(
    path.join(bumpedDir, HAIVE_DATA_FILES.plan),
    JSON.stringify({
      ...mirror,
      edges: [
        ...mirror.edges,
        {
          fromNodeId: mirror.nodes[0]!.id,
          toNodeId: randomUUID(),
          kind: 'affects',
          note: null,
        },
      ],
    }),
    'utf8',
  );
  const danglingEdge = await importPlanMirror(db, freshRepoA!.id, bumpedDir);
  check(
    'a dangling plan link imports nothing',
    danglingEdge.imported === false && danglingEdge.reason?.includes('dangling plan link') === true,
    danglingEdge,
  );

  await writeFile(
    path.join(bumpedDir, HAIVE_DATA_FILES.plan),
    JSON.stringify({
      ...mirror,
      codeLinks: [
        ...mirror.codeLinks,
        {
          nodeId: randomUUID(),
          repoPath: 'src/dangling.ts',
          symbol: null,
          evidence: null,
          derivedAtCommit: null,
          stale: false,
        },
      ],
    }),
    'utf8',
  );
  const danglingCodeLink = await importPlanMirror(db, freshRepoA!.id, bumpedDir);
  check(
    'a dangling code link imports nothing',
    danglingCodeLink.imported === false &&
      danglingCodeLink.reason?.includes('dangling code link') === true,
    danglingCodeLink,
  );

  await writeFile(
    path.join(bumpedDir, HAIVE_DATA_FILES.plan),
    JSON.stringify({
      ...mirror,
      nodes: mirror.nodes.map((node) =>
        node.parentId === null ? { ...node, parentId: mirror.nodes[1]!.id } : node,
      ),
    }),
    'utf8',
  );
  const rootless = await importPlanMirror(db, freshRepoA!.id, bumpedDir);
  check(
    'a malformed tree imports nothing',
    rootless.imported === false && rootless.reason?.includes('exactly one root') === true,
    rootless,
  );
  const malformedRows = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, freshRepoA!.id));
  check('all rejected snapshots leave no partial rows', malformedRows.length === 0, malformedRows);
  await db.delete(schema.repositories).where(eq(schema.repositories.id, freshRepoA!.id));
  await rm(bumpedDir, { recursive: true, force: true });

  // The same ids under a DIFFERENT repository would collide on the primary key,
  // and a partial insert is worse than none — so the whole import is refused.
  const [freshRepoB] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-smoke-dup', source: 'blank', status: 'ready' })
    .returning();
  state.mirrorRepoId = freshRepoB!.id;
  const collided = await importPlanMirror(db, freshRepoB!.id, tmpDir);
  check(
    'a duplicate repo does not half-import the same ids',
    collided.imported === false,
    collided,
  );
  const strayCount = (
    await db
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, freshRepoB!.id))
  ).length;
  check('the refused import left no partial tree', strayCount === 0, strayCount);

  // A genuine fresh clone: the source repo is gone, so the ids are free.
  await db.delete(schema.repositories).where(eq(schema.repositories.id, repositoryId));
  state.repoId = undefined;
  const restored = await importPlanMirror(db, freshRepoB!.id, tmpDir);
  check('a fresh clone restores the plan', restored.imported === true, restored);

  const restoredNodes = await db
    .select({
      id: schema.planNodes.id,
      parentId: schema.planNodes.parentId,
      path: schema.planNodes.path,
      ordinal: schema.planNodes.ordinal,
      title: schema.planNodes.title,
      kind: schema.planNodes.kind,
      body: schema.planNodes.body,
      status: schema.planNodes.status,
      taskable: schema.planNodes.taskable,
    })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, freshRepoB!.id));
  check(
    'restore recreates every opaque node reference',
    restoredNodes.length === sourceNodes.length &&
      sourceNodes.every((n) => restoredNodes.some((r) => r.id === n.id)),
    { restored: restoredNodes.length, source: sourceNodes.length },
  );
  check(
    'restore rebuilds every path from parentage',
    restoredNodes.every((r) => sourceNodes.find((n) => n.id === r.id)?.path === r.path),
    restoredNodes.map((r) => r.path),
  );
  check(
    'restore preserves the complete portable node state',
    JSON.stringify(
      restoredNodes
        .map(({ path: _path, ...node }) => node)
        .sort((a, b) => a.id.localeCompare(b.id)),
    ) === JSON.stringify([...sourcePortableNodes].sort((a, b) => a.id.localeCompare(b.id))),
    restoredNodes,
  );
  const restoredEdges = await db
    .select({
      fromNodeId: schema.planNodeEdges.fromNodeId,
      toNodeId: schema.planNodeEdges.toNodeId,
      kind: schema.planNodeEdges.kind,
      note: schema.planNodeEdges.note,
    })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, freshRepoB!.id));
  check('restore carries the edges', restoredEdges.length === mirror.edges.length, {
    restored: restoredEdges.length,
    mirror: mirror.edges.length,
  });
  const restoredCodeLinks = await db
    .select({
      nodeId: schema.planNodeCodeLinks.nodeId,
      repoPath: schema.planNodeCodeLinks.repoPath,
      symbol: schema.planNodeCodeLinks.symbol,
      evidence: schema.planNodeCodeLinks.evidence,
      derivedAtCommit: schema.planNodeCodeLinks.derivedAtCommit,
      stale: schema.planNodeCodeLinks.stale,
    })
    .from(schema.planNodeCodeLinks)
    .where(eq(schema.planNodeCodeLinks.repositoryId, freshRepoB!.id));
  check(
    'restore carries code links and their state',
    JSON.stringify(
      [...restoredCodeLinks].sort((a, b) =>
        `${a.nodeId}:${a.repoPath}:${a.symbol ?? ''}`.localeCompare(
          `${b.nodeId}:${b.repoPath}:${b.symbol ?? ''}`,
        ),
      ),
    ) ===
      JSON.stringify(
        [...sourceCodeLinks].sort((a, b) =>
          `${a.nodeId}:${a.repoPath}:${a.symbol ?? ''}`.localeCompare(
            `${b.nodeId}:${b.repoPath}:${b.symbol ?? ''}`,
          ),
        ),
      ),
    restoredCodeLinks,
  );

  const restoredSkeletons = await loadPlanSkeletons(db, freshRepoB!.id);
  const restoredBadges = toNodeViews(
    restoredSkeletons,
    computePlanSequence(restoredSkeletons, await loadPlanEdges(db, freshRepoB!.id)),
  )
    .map((node) => ({
      title: node.title,
      rolledStatus: node.rolledStatus,
      directChildren: node.directChildren,
      totalDescendants: node.totalDescendants,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  check(
    'restore recomputes roll-up and count badges from portable inputs',
    JSON.stringify(restoredBadges) === JSON.stringify(sourceBadges),
    { sourceBadges, restoredBadges },
  );

  const restoredConstruction = await db
    .select({ sourceTaskId: schema.planNodes.sourceTaskId })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, freshRepoB!.id));
  check(
    'restore does not recreate source-task provenance',
    restoredConstruction.every((node) => node.sourceTaskId === null),
    restoredConstruction,
  );

  const [restoredMarkdownNodes, restoredMarkdownEdges] = await Promise.all([
    loadPlanNodes(db, freshRepoB!.id),
    loadPlanEdges(db, freshRepoB!.id),
  ]);
  check(
    'restore reconstructs the complete committed plan.md',
    renderPlanMarkdownFrom(restoredMarkdownNodes, restoredMarkdownEdges) === markdown,
  );

  const restoredIds = restoredNodes.map((node) => node.id);
  const [restoredMessages, restoredTaskLinks, restoredReads] = await Promise.all([
    db
      .select({ id: schema.planNodeMessages.id })
      .from(schema.planNodeMessages)
      .where(inArray(schema.planNodeMessages.nodeId, restoredIds)),
    db
      .select({ id: schema.planNodeTasks.id })
      .from(schema.planNodeTasks)
      .where(inArray(schema.planNodeTasks.nodeId, restoredIds)),
    db
      .select({ nodeId: schema.userPlanNodeReads.nodeId })
      .from(schema.userPlanNodeReads)
      .where(inArray(schema.userPlanNodeReads.nodeId, restoredIds)),
  ]);
  check(
    'restore does not recreate chat, task links or read markers',
    restoredMessages.length === 0 && restoredTaskLinks.length === 0 && restoredReads.length === 0,
    { restoredMessages, restoredTaskLinks, restoredReads },
  );

  /* --- 12.4 completion greens `implements`, never `touched` ---------------- */

  // The whole point of the role column. The spec writer records every component
  // a task AFFECTS; greening those would turn a statement about blast radius
  // into a claim the work is finished.
  const roleRoot = (await loadPlanNodes(db, freshRepoB!.id)).find((n) => n.parentId === null)!;
  const rolePatch = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'tmp-impl', parentRef: roleRoot.id, title: 'Work this task IS' },
        {
          op: 'upsert',
          nodeRef: 'tmp-touch',
          parentRef: roleRoot.id,
          title: 'Work this task merely touched',
        },
      ],
    },
    { repositoryId: freshRepoB!.id, origin: 'user' },
  );
  const implNodeId = rolePatch.created[0]!;
  const touchedNodeId = rolePatch.created[1]!;

  const [roleTask] = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: 'workflow',
      title: 'plan-smoke role fixture',
      repositoryId: freshRepoB!.id,
      status: 'running',
    })
    .returning();
  await db.insert(schema.planNodeTasks).values([
    { nodeId: implNodeId, taskId: roleTask!.id, role: 'implements' },
    { nodeId: touchedNodeId, taskId: roleTask!.id, role: 'touched' },
  ]);

  // The touched-writer must never downgrade an existing implements row.
  await db
    .insert(schema.planNodeTasks)
    .values({ nodeId: implNodeId, taskId: roleTask!.id, role: 'touched' })
    .onConflictDoNothing();
  const [stillImplements] = await db
    .select({ role: schema.planNodeTasks.role })
    .from(schema.planNodeTasks)
    .where(
      and(
        eq(schema.planNodeTasks.nodeId, implNodeId),
        eq(schema.planNodeTasks.taskId, roleTask!.id),
      ),
    );
  check(
    'a touched write cannot downgrade an implements link',
    stillImplements?.role === 'implements',
    stillImplements,
  );

  await completePlanNodesForTask(db, roleTask!.id);
  const afterRole = await loadPlanNodes(db, freshRepoB!.id);
  check(
    'completion greens the node the task implements',
    afterRole.find((n) => n.id === implNodeId)?.status === 'done',
    afterRole.find((n) => n.id === implNodeId)?.status,
  );
  check(
    'completion leaves a node the task merely touched alone',
    afterRole.find((n) => n.id === touchedNodeId)?.status === 'todo',
    afterRole.find((n) => n.id === touchedNodeId)?.status,
  );
  await db.delete(schema.tasks).where(eq(schema.tasks.id, roleTask!.id));
  // Clean up after this section. The pull reconcile below counts nodes that
  // exist only locally, and two fixture nodes left behind are two local-only
  // nodes — a fixture that quietly changes a later assertion is worse than no
  // fixture at all.
  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'delete', nodeRef: implNodeId },
        { op: 'delete', nodeRef: touchedNodeId },
      ],
    },
    { repositoryId: freshRepoB!.id, origin: 'user' },
  );

  /* --- 12.5 reconciling a PULLED snapshot onto a plan that exists ---------- */

  // What a `git pull` does to a plan that is already here. `importPlanMirror`
  // refuses this case outright, which is exactly why the reconcile exists — and
  // the property that matters is the one a merge cannot infer: a node present
  // only locally is KEPT, because "someone added it here" and "someone deleted
  // it there" are indistinguishable from the file and only one is reversible.
  const pullDir = await mkdtemp(path.join(os.tmpdir(), 'plan-pull-'));
  await mkdir(path.join(pullDir, '.haive-data'), { recursive: true });

  const localOnly = await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: 'tmp-local',
          parentRef: mirror.nodes.find((n) => n.parentId === null)!.id,
          title: 'Added here, never pushed',
        },
      ],
    },
    { repositoryId: freshRepoB!.id, origin: 'user' },
  );
  const localOnlyId = localOnly.created[0]!;

  const incomingId = randomUUID();
  const incomingMirror = {
    ...mirror,
    nodes: [
      ...mirror.nodes.map((n, i) => (i === 0 ? { ...n, title: 'Retitled on the other side' } : n)),
      {
        id: incomingId,
        parentId: mirror.nodes.find((n) => n.parentId === null)!.id,
        ordinal: 99,
        title: 'Added on the other side',
        kind: 'component' as const,
        body: null,
        status: 'todo' as const,
        taskable: false,
      },
    ],
  };
  await writeFile(
    path.join(pullDir, HAIVE_DATA_FILES.plan),
    JSON.stringify(incomingMirror),
    'utf8',
  );

  const pulled = await reconcilePlanMirror(db, freshRepoB!.id, pullDir);
  check(
    'a pull adds the incoming node and updates the shared ones',
    pulled.nodesCreated === 1 && pulled.nodesUpdated === mirror.nodes.length,
    pulled,
  );
  check(
    'a pull KEEPS a node that exists only locally, and names it',
    pulled.keptLocal.length === 1 && pulled.keptLocal[0] === localOnlyId,
    pulled.keptLocal,
  );

  const afterPull = await loadPlanNodes(db, freshRepoB!.id);
  check(
    'the local-only node survives the pull',
    afterPull.some((n) => n.id === localOnlyId),
    afterPull.length,
  );
  check(
    'the incoming node lands with its own id',
    afterPull.some((n) => n.id === incomingId && n.title === 'Added on the other side'),
  );
  check(
    'a title changed on the other side lands here',
    afterPull.some((n) => n.id === mirror.nodes[0]!.id && n.title === 'Retitled on the other side'),
  );
  // A kept node can sit under a parent the snapshot MOVED, so the ancestry is
  // rebuilt for the whole plan rather than for the rows that look affected.
  const pathById = new Map(afterPull.map((n) => [n.id, n.path]));
  check(
    'every path still closes against its parent after the merge',
    afterPull.every(
      (n) => n.path === `${n.parentId === null ? '/' : pathById.get(n.parentId)}${n.id}/`,
    ),
    afterPull.map((n) => n.path),
  );

  // Atomicity: a snapshot whose parentage does not resolve must change nothing.
  const beforeBad = (await loadPlanNodes(db, freshRepoB!.id)).length;
  await writeFile(
    path.join(pullDir, HAIVE_DATA_FILES.plan),
    JSON.stringify({
      ...incomingMirror,
      nodes: [
        ...incomingMirror.nodes,
        {
          id: randomUUID(),
          parentId: randomUUID(),
          ordinal: 0,
          title: 'Orphan',
          kind: 'component' as const,
          body: null,
          status: 'todo' as const,
          taskable: false,
        },
      ],
    }),
    'utf8',
  );
  let refused = false;
  try {
    await reconcilePlanMirror(db, freshRepoB!.id, pullDir);
  } catch {
    refused = true;
  }
  check('a snapshot with unresolvable parentage is refused', refused);
  check(
    'the refused pull changed nothing',
    (await loadPlanNodes(db, freshRepoB!.id)).length === beforeBad,
  );

  // No snapshot at all is a RESULT, not a failure: a repo that has never had one
  // committed is the common case.
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'plan-pull-empty-'));
  const nothing = await reconcilePlanMirror(db, freshRepoB!.id, emptyDir);
  check(
    'a repo with no committed snapshot reports it rather than failing',
    nothing.skipped !== null,
    nothing,
  );
  await rm(pullDir, { recursive: true, force: true }).catch(() => {});
  await rm(emptyDir, { recursive: true, force: true }).catch(() => {});

  /* --- 13. deleting the ROOT clears every attached table ------------------- */

  // What the "delete this plan" action does, run last and on the restored
  // plan because it destroys whatever it touches. The blast radius is entirely
  // FK cascade, so it cannot be asserted anywhere but against a real database,
  // and being wrong in either direction is serious: too little leaves rows that
  // resurrect the plan, too much would take the user's TASKS with it.
  const doomedRepoId = freshRepoB!.id;
  const restoredRoot = await findPlanRoot(db, doomedRepoId);
  const victim = restoredNodes.find((n) => n.id !== restoredRoot!.id)!;

  await db.insert(schema.planNodeCodeLinks).values({
    repositoryId: doomedRepoId,
    nodeId: victim.id,
    repoPath: 'src/index.ts',
    symbol: 'main',
    evidence: 'line 1',
    derivedAtCommit: 'deadbeef',
  });
  await db.insert(schema.planNodeMessages).values({
    nodeId: victim.id,
    taskId: linkTaskId,
    role: 'user',
    body: 'does this survive a plan delete?',
  });
  await db.insert(schema.planNodeTasks).values({ nodeId: victim.id, taskId: linkTaskId });
  await db
    .insert(schema.userPlanNodeReads)
    .values({ userId, nodeId: victim.id, lastReadAt: new Date() });

  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: restoredRoot!.id }] },
    { repositoryId: doomedRepoId, origin: 'user' },
  );

  const leftNodes = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, doomedRepoId));
  check('deleting the root leaves no nodes', leftNodes.length === 0, leftNodes.length);

  const leftLinks = await db
    .select({ id: schema.planNodeCodeLinks.id })
    .from(schema.planNodeCodeLinks)
    .where(eq(schema.planNodeCodeLinks.repositoryId, doomedRepoId));
  check('code links go with the plan', leftLinks.length === 0, leftLinks.length);

  const leftEdges = await db
    .select({ id: schema.planNodeEdges.id })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, doomedRepoId));
  check('edges go with the plan', leftEdges.length === 0, leftEdges.length);

  const leftMsgs = await db
    .select({ id: schema.planNodeMessages.id })
    .from(schema.planNodeMessages)
    .where(eq(schema.planNodeMessages.nodeId, victim.id));
  check('chat transcripts go with the plan', leftMsgs.length === 0, leftMsgs.length);

  const leftReads = await db
    .select({ userId: schema.userPlanNodeReads.userId })
    .from(schema.userPlanNodeReads)
    .where(eq(schema.userPlanNodeReads.nodeId, victim.id));
  check('read markers go with the plan', leftReads.length === 0, leftReads.length);

  const leftTaskLinks = await db
    .select({ taskId: schema.planNodeTasks.taskId })
    .from(schema.planNodeTasks)
    .where(eq(schema.planNodeTasks.nodeId, victim.id));
  check('the task LINK goes with the plan', leftTaskLinks.length === 0, leftTaskLinks.length);

  // The one thing that must NOT go. Deleting a plan must never delete the
  // user's work; only the link between them belongs to the plan.
  const survivingTask = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, linkTaskId));
  check('the TASK itself survives the plan', survivingTask.length === 1, survivingTask.length);
}

main()
  .then(() => {
    if (failures.length > 0) {
      log.error({ failures }, `[smoke] ${failures.length} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    log.info('[smoke] plan-canvas smoke passed');
  })
  .catch((err) => {
    log.error({ err }, '[smoke] plan-canvas smoke threw');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = getDb();
      // plan_nodes cascade from the repository row; the user row is last.
      if (state.repoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repoId));
      }
      if (state.taskId) await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      if (state.mirrorRepoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.mirrorRepoId));
      }
      if (state.userId) await db.delete(schema.users).where(eq(schema.users.id, state.userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'db cleanup failed');
    }
    if (state.tmpDir) await rm(state.tmpDir, { recursive: true, force: true }).catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
