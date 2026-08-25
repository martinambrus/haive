/**
 * Integration smoke for the plan canvas persistence layer against a real Postgres.
 *
 * The unit tests in `shared/src/plan/paths.test.ts` cover the path arithmetic in
 * isolation; what they cannot cover is the part that only exists in the database:
 * a patch is ONE transaction, `path` is rewritten for every descendant of a moved
 * subtree by a SQL substring, a delete cascades through a self-FK, and
 * `expectedVersion` has to lose a race with a concurrent write. The second half
 * covers the `.haive-data/` mirror, whose whole job is to restore a plan
 * VERBATIM onto a fresh clone.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
// Subpath, not the root barrel: the plan applier reaches the database, and the
// barrel is what pulls ioredis/dns into anything that imports it.
import { PlanPatchError, applyPlanPatch, findPlanRoot } from '@haive/shared/plan';
import { HAIVE_DATA_FILES, PLAN_MIRROR_SCHEMA_VERSION, type PlanMirror } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { importPlanMirror, writePlanMirror } from '../src/plan/mirror.js';

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

  /* --- 11. the .haive-data mirror round-trips onto a fresh clone ----------- */

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'plan-mirror-'));
  state.tmpDir = tmpDir;
  const written = await writePlanMirror(db, repositoryId, tmpDir);
  check(
    'writePlanMirror writes both files',
    written.includes(HAIVE_DATA_FILES.plan) && written.includes(HAIVE_DATA_FILES.planMarkdown),
    written,
  );

  const mirrorRaw = await readFile(path.join(tmpDir, HAIVE_DATA_FILES.plan), 'utf8');
  const mirror = JSON.parse(mirrorRaw) as PlanMirror;
  const sourceNodes = await nodes();
  check('the mirror carries every node', mirror.nodes.length === sourceNodes.length, {
    mirror: mirror.nodes.length,
    db: sourceNodes.length,
  });

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
  await writeFile(
    path.join(bumpedDir, 'plan.json'),
    JSON.stringify({ ...mirror, schemaVersion: PLAN_MIRROR_SCHEMA_VERSION + 1 }),
    'utf8',
  );
  const [freshRepoA] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-smoke-vbump', source: 'blank', status: 'ready' })
    .returning();
  const rejected = await importPlanMirror(db, freshRepoA!.id, bumpedDir);
  check('a future schemaVersion imports nothing', rejected.imported === false, rejected);
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
      title: schema.planNodes.title,
    })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, freshRepoB!.id));
  check(
    'restore preserves node ids verbatim',
    restoredNodes.length === sourceNodes.length &&
      sourceNodes.every((n) => restoredNodes.some((r) => r.id === n.id)),
    { restored: restoredNodes.length, source: sourceNodes.length },
  );
  check(
    'restore rebuilds every path from parentage',
    restoredNodes.every((r) => sourceNodes.find((n) => n.id === r.id)?.path === r.path),
    restoredNodes.map((r) => r.path),
  );
  const restoredEdges = await db
    .select({ id: schema.planNodeEdges.id })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, freshRepoB!.id));
  check('restore carries the edges', restoredEdges.length === mirror.edges.length, {
    restored: restoredEdges.length,
    mirror: mirror.edges.length,
  });
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
