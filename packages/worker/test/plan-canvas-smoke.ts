import { fixtureBase, networkGitArgs } from './support/smoke-git-http.js';
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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, like, notInArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { pendingConflictUnits, upgradeAdmission } from '@haive/shared/onboarding-admission';
import { blocksUpgrade } from '@haive/shared/project-state-conflicts';
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
  markPlanMirrorDirty,
  renderPlanMarkdownFrom,
  toNodeViews,
} from '@haive/shared/plan';
import { markPlanCodeLinksStale } from '../src/plan/code-link-staleness.js';
import { HAIVE_DATA_FILES, PLAN_MIRROR_SCHEMA_VERSION, type PlanMirror } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { gitRun } from '../src/repo/git-exec.js';
import { sweepDirtyPlanMirrors } from '../src/queues/plan-mirror-queue.js';
import { persistDetection } from '../src/repo/clone.js';
import {
  advancePlanBaseFromCommit,
  advancePlanBaseToPushed,
  importPlanMirror,
  reconcilePlanFromCheckout,
  seedPlanBaseFromCheckout,
  stampPlanMirrorHashesAtBoot,
  writePlanMirror,
} from '../src/plan/mirror.js';
import { completePlanNodesForTask } from '../src/plan/task-link.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { resolveAffectedComponents } from '../src/step-engine/steps/workflow/_affected-components.js';
import { loadSeededPlanNodes } from '../src/step-engine/steps/workflow/_plan-task-nodes.js';

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

  // An AGENT's change to an existing node carries the version it read, or a person's canvas
  // edit made meanwhile is replaced without anyone knowing. The op without one is dropped and
  // reported, the rest of the reply lands, and an ordinal-only reorder is exempt.
  const agentOpts = {
    repositoryId,
    origin: 'llm' as const,
    onUnresolvableRef: 'drop' as const,
    requireExpectedVersion: true,
  };
  const nodeOf = async (id: string) =>
    (await loadPlanNodes(db, repositoryId)).find((n) => n.id === id);
  const authBefore = (await nodeOf(auth!.id))!;
  const unversioned = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: auth!.id, body: 'agent rewrite' },
        { op: 'delete', nodeRef: login!.id },
        { op: 'upsert', nodeRef: 'agent-new', parentRef: root!.id, title: 'Agent addition' },
      ],
    },
    agentOpts,
  );
  const authAfter = (await nodeOf(auth!.id))!;
  check(
    'an agent change or delete without its version is dropped and reported',
    unversioned.dropped.length === 2 &&
      unversioned.created.length === 1 &&
      authAfter.body === authBefore.body &&
      authAfter.version === authBefore.version &&
      (await nodeOf(login!.id)) !== undefined,
    unversioned,
  );
  const reordered = await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: auth!.id, ordinal: authBefore.ordinal }] },
    agentOpts,
  );
  check(
    'an ordinal-only agent reorder needs no version',
    reordered.updated.length === 1 && reordered.dropped.length === 0,
    reordered,
  );
  const authNow = (await nodeOf(auth!.id))!;
  const versioned = await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: auth!.id,
          expectedVersion: authNow.version,
          body: 'agent rewrite',
        },
      ],
    },
    agentOpts,
  );
  check(
    'an agent change carrying its version lands',
    versioned.updated.length === 1 && (await nodeOf(auth!.id))?.body === 'agent rewrite',
    versioned,
  );
  const scratch = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'sp', parentRef: root!.id, title: 'Scratch parent' },
        { op: 'upsert', nodeRef: 'sc', parentRef: 'sp', title: 'Scratch child' },
      ],
    },
    { repositoryId, origin: 'user' },
  );
  const scratchParent = (await nodeOf(scratch.refs.sp!))!;
  const scratchChild = (await nodeOf(scratch.refs.sc!))!;
  const parentFirst = await applyPlanPatch(
    db,
    {
      ops: [{ op: 'delete', nodeRef: scratchParent.id, expectedVersion: scratchParent.version }],
    },
    agentOpts,
  );
  check(
    'an agent delete of a node that still has children is dropped, its version notwithstanding',
    parentFirst.dropped.length === 1 &&
      parentFirst.deleted.length === 0 &&
      (await nodeOf(scratchChild.id)) !== undefined,
    parentFirst,
  );
  const leafFirst = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'delete', nodeRef: scratchChild.id, expectedVersion: scratchChild.version },
        { op: 'delete', nodeRef: scratchParent.id, expectedVersion: scratchParent.version },
      ],
    },
    agentOpts,
  );
  check(
    'an agent removes a subtree leaf by leaf, each delete carrying its version',
    leafFirst.deleted.length === 2 && leafFirst.dropped.length === 0,
    leafFirst,
  );
  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: auth!.id, body: authBefore.body },
        { op: 'delete', nodeRef: unversioned.created[0]! },
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

  /* --- 8.5 under drop, a ref that cannot resolve costs only its own op ---- */

  // MEASURED: four ordering replies of 16-45 ops each were lost whole to one
  // mistyped uuid apiece, every one a near-copy of an id in the agent's prompt.
  const staleSibling = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: login!.id, title: 'Resurrected' },
        { op: 'upsert', nodeRef: 'survivor', parentRef: api!.id, title: 'Beside a stale id' },
        { op: 'link', fromRef: 'survivor', toRef: web!.id, kind: 'implements' },
      ],
    },
    { repositoryId, origin: 'llm', onUnresolvableRef: 'drop' },
  );
  check(
    'an agent upsert naming a deleted node loses its own op, not the reply',
    staleSibling.created.length === 1 &&
      staleSibling.linked === 1 &&
      staleSibling.dropped.length === 1 &&
      staleSibling.dropped[0]!.includes(login!.id) &&
      (await byTitle('Resurrected')) === undefined,
    staleSibling,
  );

  // The pre-flight reads a patch as a set, while the op loop resolves in order.
  const forward = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'link', fromRef: 'late', toRef: web!.id, kind: 'affects' },
        { op: 'upsert', nodeRef: 'late', parentRef: api!.id, title: 'Introduced after its link' },
      ],
    },
    { repositoryId, origin: 'llm', onUnresolvableRef: 'drop' },
  );
  check(
    'a link naming a temp id before its upsert loses the link, not the node',
    forward.created.length === 1 && forward.linked === 0 && forward.dropped.length === 1,
    forward,
  );

  // A delete takes its whole subtree, including a node this same patch created
  // under it, so no pre-flight can know which ids a later op may still name.
  const doomed = await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: 'doomed', parentRef: api!.id, title: 'Doomed' }] },
    { repositoryId, origin: 'user' },
  );
  const doomedId = doomed.refs.doomed!;
  const afterDelete = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'orphan', parentRef: doomedId, title: 'Created, then deleted' },
        { op: 'delete', nodeRef: doomedId },
        { op: 'link', fromRef: 'orphan', toRef: web!.id, kind: 'affects' },
        { op: 'upsert', nodeRef: doomedId, title: 'Renamed after its delete' },
        { op: 'upsert', nodeRef: 'orphan', parentRef: api!.id, title: 'Resurrected orphan' },
        { op: 'upsert', nodeRef: 'bystander', parentRef: api!.id, title: 'Beside a delete' },
      ],
    },
    { repositoryId, origin: 'llm', onUnresolvableRef: 'drop' },
  );
  const titlesAfterDelete = (await nodes()).map((n) => n.title);
  check(
    'ops naming a node deleted earlier in the patch are dropped, not fatal',
    afterDelete.deleted.length === 1 &&
      afterDelete.dropped.length === 3 &&
      titlesAfterDelete.includes('Beside a delete') &&
      !titlesAfterDelete.some((t) =>
        [
          'Doomed',
          'Created, then deleted',
          'Renamed after its delete',
          'Resurrected orphan',
        ].includes(t),
      ),
    { afterDelete, titlesAfterDelete },
  );

  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'delete', nodeRef: staleSibling.refs.survivor! },
        { op: 'delete', nodeRef: forward.refs.late! },
        { op: 'delete', nodeRef: afterDelete.refs.bystander! },
      ],
    },
    { repositoryId, origin: 'user' },
  );

  /* --- 8.6 under strip, a malformed code link costs only the link ----------- */

  // MEASURED: 2 of 81 plan-build agents lost a whole reply to one bad link — a
  // path under the wrong key, a `symbol` past 512 characters.
  const badLinks = {
    ops: [
      {
        op: 'upsert',
        nodeRef: 'linked',
        parentRef: api!.id,
        title: 'Carries one bad link',
        codeLinks: [{ repoPath: 'src/api.ts' }, { path: 'src/wrong-key.ts' }],
      },
    ],
  };
  const stripped = await applyPlanPatch(db, badLinks, {
    repositoryId,
    origin: 'llm',
    onUnresolvableRef: 'drop',
    onInvalidCodeLink: 'strip',
  });
  check(
    'an agent patch with a malformed code link lands its op and the valid link',
    stripped.created.length === 1 &&
      stripped.codeLinked === 1 &&
      stripped.dropped.length === 0 &&
      stripped.strippedCodeLinks.length === 1,
    stripped,
  );
  await expectPatchError("the same link still rejects a person's patch whole", 'invalid', () =>
    applyPlanPatch(db, badLinks, { repositoryId, origin: 'user' }),
  );
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: stripped.refs.linked! }] },
    { repositoryId, origin: 'user' },
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
        role: schema.planNodeCodeLinks.role,
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

  // A test file is linked with `role: 'covers'`. The impact block hands those to
  // the test-management step, which is the only way it can be told which tests
  // cover a component — a test references URLs and selectors, not source paths.
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          codeLinks: [
            {
              repoPath: 'tests/mobile/App.spec.ts',
              role: 'covers',
              evidence: 'drives the shell end to end',
            },
          ],
        },
      ],
    },
    { repositoryId, origin: 'llm', derivedAtCommit: 'jkl012' },
  );
  links = await readLinks();
  const testLink = links.find((l) => l.repoPath === 'tests/mobile/App.spec.ts');
  check(
    'a test file links as covers, beside the implementation links',
    testLink?.role === 'covers',
    {
      links,
    },
  );
  check(
    'an implementation link keeps the default role',
    links.filter((l) => l.repoPath === 'src/mobile/App.tsx').every((l) => l.role === 'implements'),
    links,
  );

  // The demotion guard: re-assertion is the NORMAL event, and most prompts never
  // mention roles. An op that omits `role` must leave the stored one alone.
  await applyPlanPatch(
    db,
    {
      ops: [
        {
          op: 'upsert',
          nodeRef: linkTarget!.id,
          codeLinks: [{ repoPath: 'tests/mobile/App.spec.ts', evidence: 're-checked' }],
        },
      ],
    },
    { repositoryId, origin: 'llm', derivedAtCommit: 'mno345' },
  );
  links = await readLinks();
  check(
    're-asserting a covers link without naming a role does NOT demote it',
    links.find((l) => l.repoPath === 'tests/mobile/App.spec.ts')?.role === 'covers',
    links,
  );

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

  // ---- what gate 1 shows the approver -------------------------------------
  //
  // The resolver reads the spec's `node:<uuid>` refs and walks the edge graph
  // from ALL of them. It used to walk each named node separately for the LIST
  // and then draw the diagram from `named[0]` alone — on a real task that drew
  // 19 of 363 components while reporting nothing omitted.
  {
    const smokeCtx = {
      db,
      taskId: linkTaskId,
      logger: log,
    } as unknown as Parameters<typeof resolveAffectedComponents>[0];
    const spec = `Touches node:${linkTarget!.id} and nothing else worth naming.`;
    const resolved = await resolveAffectedComponents(smokeCtx, repositoryId, spec);
    check(
      'the node refs in a spec resolve to plan components',
      resolved?.named.length === 1,
      resolved?.named,
    );
    check(
      'a named component carries its plan parent, so the list groups like the tree',
      resolved?.named[0]?.parentTitle != null,
      resolved?.named[0],
    );
    const reachedById = new Map((resolved?.reached ?? []).map((r) => [r.id, r]));
    check(
      'a forward edge is recorded as followed WITH the arrow',
      reachedById.get(opsNode!.id)?.reversed === false,
      reachedById.get(opsNode!.id),
    );
    // Without this the grouped view labels an inbound edge "Depends on" instead
    // of "Depended on by" — the two are opposite facts about the same row.
    check(
      'an inbound edge is recorded as followed AGAINST the arrow',
      reachedById.get(legalNode!.id)?.reversed === true,
      reachedById.get(legalNode!.id),
    );
    check(
      'the walk keeps going past one hop',
      reachedById.get(api!.id)?.depth === 2,
      reachedById.get(api!.id),
    );
    check(
      'no named component is also listed as something it reaches',
      !reachedById.has(linkTarget!.id),
      [...reachedById.keys()],
    );
    // One picture per radius the walk reached, so the gate's reach buttons have
    // something to switch between without re-deriving the traversal in a browser
    // that has no `viaNodeId` to draw an edge from.
    const diagrams = resolved?.diagrams ?? [];
    const byDepth = new Map(diagrams.map((d) => [d.depth, d]));
    check(
      'a diagram is emitted for every radius the walk reached',
      JSON.stringify(diagrams.map((d) => d.depth)) === JSON.stringify([1, 2]),
      diagrams.map((d) => d.depth),
    );
    check(
      'each diagram is a flowchart drawing the named component as an origin',
      diagrams.length > 0 &&
        diagrams.every(
          (d) =>
            d.mermaid.startsWith('flowchart LR') &&
            d.mermaid.includes(`pnode${linkTarget!.id.replace(/-/g, '')}["`) &&
            d.mermaid.includes(':::origin'),
        ),
      diagrams.map((d) => d.mermaid.slice(0, 40)),
    );
    // The radius is what decides the picture: a node two hops out belongs to the
    // two-hop diagram and to no smaller one.
    const twoHopsOut = `pnode${api!.id.replace(/-/g, '')}`;
    check(
      'a node two hops out is absent from the one-hop picture',
      byDepth.get(1)?.mermaid.includes(twoHopsOut) === false && byDepth.get(1)?.omitted === 0,
      { omitted: byDepth.get(1)?.omitted },
    );
    check(
      'the same node IS drawn once the radius reaches it',
      byDepth.get(2)?.mermaid.includes(twoHopsOut) === true,
      byDepth.get(2)?.mermaid,
    );
    check(
      'a named set inside the diagram cap leaves no component undrawn',
      resolved?.namedOmitted === 0,
      resolved?.namedOmitted,
    );
    check(
      'a spec that names no plan node resolves to nothing at all',
      (await resolveAffectedComponents(smokeCtx, repositoryId, 'no refs here')) === undefined,
    );
  }

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

  const tmpDir = await mkdtemp(path.join(fixtureBase, 'plan-mirror-'));
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
      role: schema.planNodeCodeLinks.role,
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
  const bumpedDir = await mkdtemp(path.join(fixtureBase, 'plan-mirror-v'));
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
      role: schema.planNodeCodeLinks.role,
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
  // The same role split bounds the SPEC PROMPT. `recordTouchedPlanNodes` writes a
  // `touched` row for every component the spec named, so a seeded set that read
  // every role fed each round's blast radius back into the next round's prompt with
  // full node bodies — MEASURED on task 681f0f99, 5 links at creation grew to 363
  // and the seeded block went 9,493 to 232,365 chars across two rounds.
  const seededForSpec = await loadSeededPlanNodes(
    { db, taskId: roleTask!.id } as unknown as Parameters<typeof loadSeededPlanNodes>[0],
    freshRepoB!.id,
  );
  check(
    'the spec prompt is seeded from implements links only',
    seededForSpec?.nodes.length === 1 && seededForSpec.nodes[0]?.id === implNodeId,
    seededForSpec?.nodes.map((n) => n.id),
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

  /* --- 12.4b ONE task, SEVERAL nodes --------------------------------------- */

  // `completePlanNodesForTask` has always looped over its links and grouped them
  // by repository; it simply never received more than one, because the create
  // endpoint could only write one. Now that it can, the property that matters is
  // that N implements links green N nodes in a SINGLE patch — and that the role
  // still decides, so a task spanning a set as `touched` greens none of it.
  const spanRoot = (await loadPlanNodes(db, freshRepoB!.id)).find((n) => n.parentId === null)!;
  const spanPatch = await applyPlanPatch(
    db,
    {
      ops: ['Registration form', 'Order form', 'Contact form'].map((title, i) => ({
        op: 'upsert' as const,
        nodeRef: `tmp-span-${i}`,
        parentRef: spanRoot.id,
        title,
      })),
    },
    { repositoryId: freshRepoB!.id, origin: 'user' },
  );
  const spanNodeIds = spanPatch.created;

  const [spanTask] = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: 'workflow',
      title: 'plan-smoke multi-node fixture',
      repositoryId: freshRepoB!.id,
      status: 'running',
    })
    .returning();
  await db
    .insert(schema.planNodeTasks)
    .values(
      spanNodeIds.map((nodeId) => ({ nodeId, taskId: spanTask!.id, role: 'touched' as const })),
    );

  await completePlanNodesForTask(db, spanTask!.id);
  const afterTouchedSpan = await loadPlanNodes(db, freshRepoB!.id);
  check(
    'a task spanning several nodes as touched greens none of them',
    spanNodeIds.every((id) => afterTouchedSpan.find((n) => n.id === id)?.status === 'todo'),
    spanNodeIds.map((id) => afterTouchedSpan.find((n) => n.id === id)?.status),
  );

  // Same set, promoted to implements: this is the "yes, this task completes all
  // of these" answer the create form offers.
  await db
    .update(schema.planNodeTasks)
    .set({ role: 'implements' })
    .where(eq(schema.planNodeTasks.taskId, spanTask!.id));
  const spanVersionsBefore = new Map(
    afterTouchedSpan.filter((n) => spanNodeIds.includes(n.id)).map((n) => [n.id, n.version]),
  );

  await completePlanNodesForTask(db, spanTask!.id);
  const afterImplementsSpan = await loadPlanNodes(db, freshRepoB!.id);
  check(
    'completion greens every node the task implements',
    spanNodeIds.every((id) => afterImplementsSpan.find((n) => n.id === id)?.status === 'done'),
    spanNodeIds.map((id) => afterImplementsSpan.find((n) => n.id === id)?.status),
  );
  check(
    'the whole set is greened in ONE patch (each version advances exactly once)',
    spanNodeIds.every(
      (id) =>
        afterImplementsSpan.find((n) => n.id === id)!.version === spanVersionsBefore.get(id)! + 1,
    ),
    spanNodeIds.map((id) => ({
      before: spanVersionsBefore.get(id),
      after: afterImplementsSpan.find((n) => n.id === id)?.version,
    })),
  );

  await db.delete(schema.tasks).where(eq(schema.tasks.id, spanTask!.id));
  await applyPlanPatch(
    db,
    { ops: spanNodeIds.map((nodeRef) => ({ op: 'delete' as const, nodeRef })) },
    { repositoryId: freshRepoB!.id, origin: 'user' },
  );

  /* --- 12.4c `done_at` records a TRANSITION, not a status ------------------ */

  // Plan velocity is measured entirely from this column, so the thing that matters is not
  // "is the node done" but "did it just BECOME done". Three writes that all leave a node in
  // `done` have to produce three different outcomes.

  const doneAtOf = async (nodeId: string): Promise<Date | null> => {
    const [row] = await db
      .select({ doneAt: schema.planNodes.doneAt })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.id, nodeId))
      .limit(1);
    return row?.doneAt ?? null;
  };

  const velocityRepo = freshRepoB!.id;
  // Parented under the repository's EXISTING root: a second root is refused by design, and
  // 12.4b already created one here.
  const velocityRoot = await findPlanRoot(db, velocityRepo);
  check('the velocity fixture found a root to hang from', !!velocityRoot, velocityRoot);
  const velocityBuilt = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'vroot', parentRef: velocityRoot!.id, title: 'Velocity subtree' },
        { op: 'upsert', nodeRef: 'vtodo', parentRef: 'vroot', title: 'Starts as todo' },
        // Born done: what `from_repo` mining writes for code that already exists.
        {
          op: 'upsert',
          nodeRef: 'vborn',
          parentRef: 'vroot',
          title: 'Born done',
          status: 'done' as const,
        },
      ],
    },
    { repositoryId: velocityRepo, origin: 'llm' },
  );
  const vTodoId = velocityBuilt.refs['vtodo']!;
  const vBornId = velocityBuilt.refs['vborn']!;

  check(
    'a node CREATED done carries no completion date',
    (await doneAtOf(vBornId)) === null,
    await doneAtOf(vBornId),
  );
  check('a node created todo carries no completion date', (await doneAtOf(vTodoId)) === null);

  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: vTodoId, status: 'done' as const }] },
    { repositoryId: velocityRepo, origin: 'user' },
  );
  const firstGreen = await doneAtOf(vTodoId);
  check(
    'a transition INTO done stamps the completion date',
    firstGreen instanceof Date,
    firstGreen,
  );

  // Re-sending the status a node already has is what a full-node UI save and a re-run mining
  // pass both do. Restamping there would move every historical node into today's bucket.
  await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: vTodoId, status: 'done' as const, title: 'Renamed while done' },
      ],
    },
    { repositoryId: velocityRepo, origin: 'user' },
  );
  const afterNoop = await doneAtOf(vTodoId);
  check(
    're-sending done does NOT restamp the completion date',
    afterNoop?.getTime() === firstGreen?.getTime(),
    { firstGreen, afterNoop },
  );

  // Re-opening has to clear it, or the cumulative count would exceed the number of nodes that
  // are actually done.
  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: vTodoId, status: 'todo' as const }] },
    { repositoryId: velocityRepo, origin: 'user' },
  );
  check('a transition OUT of done clears the completion date', (await doneAtOf(vTodoId)) === null);

  // Re-greening dates the node at the SECOND completion, not the first.
  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: vTodoId, status: 'done' as const }] },
    { repositoryId: velocityRepo, origin: 'user' },
  );
  const regreen = await doneAtOf(vTodoId);
  check(
    're-greening records the latest completion, not the first',
    regreen instanceof Date &&
      firstGreen instanceof Date &&
      regreen.getTime() >= firstGreen.getTime(),
    { firstGreen, regreen },
  );

  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete' as const, nodeRef: velocityBuilt.refs['vroot']! }] },
    { repositoryId: velocityRepo, origin: 'user' },
  );

  /* --- 12.5 reconciling a PULLED snapshot onto a plan that exists ---------- */

  // What a `git pull` does to a plan that is already here. `importPlanMirror`
  // refuses this case outright, which is exactly why the reconcile exists — and
  // the property that matters is the one a merge cannot infer: a node present
  // only locally is KEPT, because "someone added it here" and "someone deleted
  // it there" are indistinguishable from the file and only one is reversible.
  const pullDir = await mkdtemp(path.join(fixtureBase, 'plan-pull-'));
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

  const pulled = await reconcilePlanFromCheckout(db, freshRepoB!.id, pullDir);
  check(
    'a pull adds the incoming node and updates only the shared node that changed',
    pulled.nodesCreated === 1 && pulled.nodesUpdated === 1,
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
    await reconcilePlanFromCheckout(db, freshRepoB!.id, pullDir);
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
  const emptyDir = await mkdtemp(path.join(fixtureBase, 'plan-pull-empty-'));
  const nothing = await reconcilePlanFromCheckout(db, freshRepoB!.id, emptyDir);
  check(
    'a repo with no committed snapshot reports it rather than failing',
    nothing.skipped !== null,
    nothing,
  );
  await rm(pullDir, { recursive: true, force: true }).catch(() => {});
  await rm(emptyDir, { recursive: true, force: true }).catch(() => {});

  /* --- 12.6 a flush never overwrites a plan.json it has not read in -------- */

  // B restored a plan, A changed node X and pushed, B fast-forwarded with plain git (not through
  // Haive), and B then edited node Y. The flush used to write B's render over the checkout and
  // drop A's X'; it must hold, keep the file, keep the database edit, and stay dirty.
  const GIT_ID = {
    GIT_AUTHOR_NAME: 'Smoke',
    GIT_AUTHOR_EMAIL: 'smoke@haive.local',
    GIT_COMMITTER_NAME: 'Smoke',
    GIT_COMMITTER_EMAIL: 'smoke@haive.local',
  };
  const git = async (cwd: string, args: string[]) => {
    const res = await gitRun(cwd, networkGitArgs(args), GIT_ID);
    if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    return res.stdout.trim();
  };
  const holdRoot = await mkdtemp(path.join(fixtureBase, 'plan-hold-'));
  const originDir = path.join(holdRoot, 'origin.git');
  const bDir = path.join(holdRoot, 'b');
  const aDir = path.join(holdRoot, 'a');
  await git(holdRoot, ['init', '-q', '--bare', '-b', 'main', originDir]);
  await git(holdRoot, ['init', '-q', '-b', 'main', bDir]);

  const [holdRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-hold-fixture', source: 'blank', status: 'ready' })
    .returning();
  const holdId = holdRepo!.id;
  const holdBuilt = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'hroot', parentRef: null, title: 'Hold root' },
        { op: 'upsert', nodeRef: 'hx', parentRef: 'hroot', title: 'X' },
        { op: 'upsert', nodeRef: 'hy', parentRef: 'hroot', title: 'Y' },
      ],
    },
    { repositoryId: holdId, origin: 'user' },
  );
  const hxId = holdBuilt.refs['hx']!;
  const hyId = holdBuilt.refs['hy']!;
  const planFile = path.join(bDir, HAIVE_DATA_FILES.plan);
  const titleIn = async (file: string, id: string): Promise<string | undefined> =>
    (JSON.parse(await readFile(file, 'utf8')) as PlanMirror).nodes.find((n) => n.id === id)?.title;
  const holdState = () =>
    db.query.planMirrorState.findFirst({ where: eq(schema.planMirrorState.repositoryId, holdId) });
  const pendingPlanRows = (repoId: string) =>
    db
      .select()
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repoId),
          like(schema.projectStateConflicts.unit, 'plan/%'),
          isNull(schema.projectStateConflicts.resolvedAt),
        ),
      );
  const editTitle = async (id: string, title: string) => {
    const [row] = await db
      .select({ version: schema.planNodes.version })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.id, id));
    await applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: id, title, expectedVersion: row!.version }] },
      { repositoryId: holdId, origin: 'user' },
    );
  };
  const flushOutcome = async (dir: string): Promise<'wrote' | 'held' | 'threw'> => {
    try {
      await writePlanMirror(db, holdId, dir);
      return 'wrote';
    } catch (err) {
      return (err as Error).name === 'PlanMirrorHeldError' ? 'held' : 'threw';
    }
  };

  await writePlanMirror(db, holdId, bDir);
  await git(bDir, ['add', '-A']);
  await git(bDir, ['commit', '-q', '-m', 'plan']);
  await git(bDir, ['remote', 'add', 'origin', originDir]);
  await git(bDir, ['push', '-q', 'origin', 'main']);
  // B is an install that restored the plan from this checkout, which is what gives it a base.
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: holdBuilt.refs['hroot']! }] },
    { repositoryId: holdId, origin: 'user' },
  );
  const restoredHold = await importPlanMirror(db, holdId, bDir);
  check('C1: B restores the plan from the checkout', restoredHold.imported, restoredHold);
  await git(holdRoot, ['clone', '-q', originDir, aDir]);
  const aPlan = path.join(aDir, HAIVE_DATA_FILES.plan);
  const aMirror = JSON.parse(await readFile(aPlan, 'utf8')) as PlanMirror;
  await writeFile(
    aPlan,
    `${JSON.stringify(
      { ...aMirror, nodes: aMirror.nodes.map((n) => (n.id === hxId ? { ...n, title: "X'" } : n)) },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await git(aDir, ['commit', '-q', '-am', 'A edits X']);
  await git(aDir, ['push', '-q', 'origin', 'main']);
  await git(bDir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  await editTitle(hyId, "Y'");

  const merged = await flushOutcome(bDir);
  const mergedState = await holdState();
  check(
    "C1: a flush after A's X' arrived and B edited Y' reads the checkout in and writes",
    merged === 'wrote',
    merged,
  );
  check(
    "C1: the checkout holds both A's X' and B's Y'",
    (await titleIn(planFile, hxId)) === "X'" && (await titleIn(planFile, hyId)) === "Y'",
  );
  check(
    'C1: the database holds both',
    (await loadPlanNodes(db, holdId)).some((n) => n.id === hxId && n.title === "X'") &&
      (await loadPlanNodes(db, holdId)).some((n) => n.id === hyId && n.title === "Y'"),
  );
  check(
    'C1: the row is clean and nothing is asked',
    !!mergedState &&
      mergedState.revision === mergedState.writtenRevision &&
      mergedState.lastError === null &&
      (await pendingPlanRows(holdId)).length === 0,
    mergedState,
  );

  // C3: two edits, each flushed, never hold on Haive's own bytes.
  await editTitle(hyId, 'Y2');
  const first = await flushOutcome(bDir);
  await editTitle(hyId, 'Y3');
  const second = await flushOutcome(bDir);
  check(
    'C3: two edits each flushed both write',
    first === 'wrote' && second === 'wrote' && (await titleIn(planFile, hyId)) === 'Y3',
    { first, second },
  );

  // C2: a merge open in the checkout.
  await git(bDir, ['commit', '-q', '-am', 'plan Y3']);
  await git(bDir, ['checkout', '-q', '-b', 'side']);
  await writeFile(path.join(bDir, 'conflict.txt'), 'side\n', 'utf8');
  await git(bDir, ['add', 'conflict.txt']);
  await git(bDir, ['commit', '-q', '-m', 'side']);
  await git(bDir, ['checkout', '-q', 'main']);
  await writeFile(path.join(bDir, 'conflict.txt'), 'main\n', 'utf8');
  await git(bDir, ['add', 'conflict.txt']);
  await git(bDir, ['commit', '-q', '-m', 'main']);
  const mergeRes = await gitRun(bDir, ['merge', 'side'], GIT_ID);
  check('C2: the fixture merge is open', mergeRes.code !== 0, mergeRes);
  await editTitle(hyId, 'Y4');
  const beforeMerge = await readFile(planFile, 'utf8');
  const midMerge = await flushOutcome(bDir);
  const midState = await holdState();
  check(
    'C2: a flush with a merge open writes nothing and keeps the row dirty',
    midMerge === 'held' &&
      (await readFile(planFile, 'utf8')) === beforeMerge &&
      !!midState &&
      midState.revision > midState.writtenRevision,
    { midMerge, midState },
  );
  await git(bDir, ['merge', '--abort']);
  check(
    'C2: the flush writes once the merge is gone',
    (await flushOutcome(bDir)) === 'wrote' && (await titleIn(planFile, hyId)) === 'Y4',
  );

  // C4: rows the sweep holds go to the back, so 25 of them cannot starve the dirty row behind.
  const stuckIds: string[] = [];
  const newSweepRepo = async (name: string, dir: string) => {
    await mkdir(dir, { recursive: true });
    const [r] = await db
      .insert(schema.repositories)
      .values({ userId, name, source: 'blank', status: 'ready', storagePath: dir })
      .returning();
    await applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: 'sroot', parentRef: null, title: name }] },
      { repositoryId: r!.id, origin: 'user' },
    );
    return r!.id;
  };
  const stuckFile = '{"unread":true}\n';
  for (let i = 0; i < 26; i++) {
    const dir = path.join(holdRoot, `stuck-${i}`);
    await mkdir(path.join(dir, '.haive-data'), { recursive: true });
    const id = await newSweepRepo(`plan-stuck-${i}`, dir);
    await writeFile(path.join(dir, HAIVE_DATA_FILES.plan), stuckFile, 'utf8');
    await db
      .update(schema.planMirrorState)
      .set({ syncedHash: 'not-the-hash-of-the-file' })
      .where(eq(schema.planMirrorState.repositoryId, id));
    stuckIds.push(id);
  }
  const nextDir = path.join(holdRoot, 'next');
  const nextId = await newSweepRepo('plan-next', nextDir);
  await db
    .update(schema.planMirrorState)
    .set({ writtenRevision: schema.planMirrorState.revision })
    .where(notInArray(schema.planMirrorState.repositoryId, [...stuckIds, nextId]));
  await sweepDirtyPlanMirrors();
  const stuckKept = (
    await Promise.all(
      stuckIds.map(async (_, i) =>
        readFile(path.join(holdRoot, `stuck-${i}`, HAIVE_DATA_FILES.plan), 'utf8'),
      ),
    )
  ).every((text) => text === stuckFile);
  check('C4: a sweep over held rows writes none of them', stuckKept);
  await sweepDirtyPlanMirrors();
  check(
    'C4: the next sweep reaches the dirty row behind 25 held ones',
    (await readFile(path.join(nextDir, HAIVE_DATA_FILES.plan), 'utf8').catch(() => null)) !== null,
  );
  await db
    .delete(schema.repositories)
    .where(inArray(schema.repositories.id, [...stuckIds, nextId]));

  // Boot pass: a clean unstamped row is stamped only where its file already is the render.
  const legacyMatch = await newSweepRepo('plan-legacy-match', path.join(holdRoot, 'legacy-match'));
  const legacyDiffers = await newSweepRepo(
    'plan-legacy-differs',
    path.join(holdRoot, 'legacy-diff'),
  );
  await writePlanMirror(db, legacyMatch, path.join(holdRoot, 'legacy-match'));
  await writePlanMirror(db, legacyDiffers, path.join(holdRoot, 'legacy-diff'));
  await writeFile(path.join(holdRoot, 'legacy-diff', HAIVE_DATA_FILES.plan), '{"hand":"edit"}\n');
  await db
    .update(schema.planMirrorState)
    .set({ syncedHash: null })
    .where(inArray(schema.planMirrorState.repositoryId, [legacyMatch, legacyDiffers]));
  await stampPlanMirrorHashesAtBoot(db);
  const hashOf = async (id: string) =>
    (
      await db.query.planMirrorState.findFirst({
        where: eq(schema.planMirrorState.repositoryId, id),
      })
    )?.syncedHash ?? null;
  check(
    'boot pass stamps a clean row whose file is the render',
    (await hashOf(legacyMatch)) !== null,
  );
  check(
    'boot pass leaves a row whose file differs unstamped',
    (await hashOf(legacyDiffers)) === null,
  );
  await markPlanMirrorDirty(db, legacyDiffers);
  await writePlanMirror(db, legacyDiffers, path.join(holdRoot, 'legacy-diff'));
  check(
    'an unstamped row adopts the file as before and is stamped by the write',
    (await readFile(path.join(holdRoot, 'legacy-diff', HAIVE_DATA_FILES.plan), 'utf8')).includes(
      'plan-legacy-differs',
    ) && (await hashOf(legacyDiffers)) !== null,
  );
  // A plan.md the flush cannot write leaves the row dirty but keeps the stamp of the plan.json that
  // landed, so the next flush does not hold Haive's own bytes as unread changes.
  const mdDir = path.join(holdRoot, 'legacy-diff');
  await rm(path.join(mdDir, HAIVE_DATA_FILES.planMarkdown));
  await symlink(
    path.join(holdRoot, 'elsewhere.md'),
    path.join(mdDir, HAIVE_DATA_FILES.planMarkdown),
  );
  await db
    .update(schema.planNodes)
    .set({ title: 'retitled under a refused plan.md' })
    .where(eq(schema.planNodes.repositoryId, legacyDiffers));
  await markPlanMirrorDirty(db, legacyDiffers);
  const mdRefused = await writePlanMirror(db, legacyDiffers, mdDir).then(
    () => 'wrote',
    () => 'failed',
  );
  const landed = await readFile(path.join(mdDir, HAIVE_DATA_FILES.plan), 'utf8');
  check(
    'a refused plan.md still stamps the plan.json that landed',
    mdRefused === 'failed' &&
      landed.includes('retitled under a refused plan.md') &&
      (await hashOf(legacyDiffers)) === createHash('sha256').update(landed).digest('hex'),
    mdRefused,
  );
  await rm(path.join(mdDir, HAIVE_DATA_FILES.planMarkdown));
  await db
    .update(schema.planNodes)
    .set({ title: 'retitled again' })
    .where(eq(schema.planNodes.repositoryId, legacyDiffers));
  await markPlanMirrorDirty(db, legacyDiffers);
  check(
    'the next flush writes over it without holding',
    await writePlanMirror(db, legacyDiffers, mdDir).then(
      () => true,
      () => false,
    ),
  );
  // An imported plan.json is stamped with the hash of its bytes, not of the text they decode to.
  let copied = await readFile(path.join(mdDir, HAIVE_DATA_FILES.plan), 'utf8');
  for (const n of (JSON.parse(copied) as PlanMirror).nodes)
    copied = copied.replaceAll(n.id, randomUUID());
  const [badHead, badTail] = copied.split('retitled again') as [string, string];
  const malformed = Buffer.concat([
    Buffer.from(`${badHead}bad `),
    Buffer.from([0xff]),
    Buffer.from(badTail),
  ]);
  const badDir = path.join(holdRoot, 'malformed');
  await mkdir(path.join(badDir, '.haive-data'), { recursive: true });
  await writeFile(path.join(badDir, HAIVE_DATA_FILES.plan), malformed);
  const [badRepo] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: 'plan-malformed',
      source: 'blank',
      status: 'ready',
      storagePath: badDir,
    })
    .returning();
  const badImport = await importPlanMirror(db, badRepo!.id, badDir);
  check(
    'an imported plan.json is stamped with the hash of its raw bytes',
    badImport.imported &&
      (await hashOf(badRepo!.id)) === createHash('sha256').update(malformed).digest('hex'),
    badImport,
  );
  await db.delete(schema.repositories).where(eq(schema.repositories.id, badRepo!.id));
  await db
    .delete(schema.repositories)
    .where(inArray(schema.repositories.id, [legacyMatch, legacyDiffers]));

  /* --- 12.6b a push the remote has already moved past ---------------------- */

  const advOrigin = path.join(holdRoot, 'adv-origin.git');
  const advDir = path.join(holdRoot, 'adv');
  await git(holdRoot, ['init', '-q', '--bare', '-b', 'main', advOrigin]);
  await git(holdRoot, ['init', '-q', '-b', 'main', advDir]);
  await git(advDir, ['remote', 'add', 'origin', advOrigin]);
  const [advRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-adv', source: 'blank', status: 'ready', storagePath: advDir })
    .returning();
  const advId = advRepo!.id;
  const advBuilt = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'aroot', parentRef: null, title: 'Adv root' },
        { op: 'upsert', nodeRef: 'ax', parentRef: 'aroot', title: 'AX' },
      ],
    },
    { repositoryId: advId, origin: 'user' },
  );
  const axId = advBuilt.refs['ax']!;
  const advBase = async () =>
    (
      await db.query.planMirrorState.findFirst({
        where: eq(schema.planMirrorState.repositoryId, advId),
      })
    )?.syncedSnapshot as PlanMirror | null;
  const clearAdvBase = () =>
    db
      .update(schema.planMirrorState)
      .set({ syncedSnapshot: null })
      .where(eq(schema.planMirrorState.repositoryId, advId));
  await writePlanMirror(db, advId, advDir);
  await git(advDir, ['add', '-A']);
  await git(advDir, ['commit', '-q', '-m', 'plan']);
  const pushedX = await git(advDir, ['rev-parse', 'HEAD']);
  await git(advDir, ['push', '-q', 'origin', 'main']);
  await writeFile(path.join(advDir, 'other.txt'), 'later\n', 'utf8');
  await git(advDir, ['add', 'other.txt']);
  await git(advDir, ['commit', '-q', '-m', 'unrelated']);
  await git(advDir, ['push', '-q', 'origin', 'main']);
  await clearAdvBase();
  await advancePlanBaseFromCommit(db, advId, advDir, pushedX, 'main');
  check(
    'a push the remote moved past with the same plan.json still becomes the base',
    (await advBase())?.nodes.some((n) => n.id === axId && n.title === 'AX') === true,
    await advBase(),
  );
  const [axRow] = await db
    .select({ version: schema.planNodes.version })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.id, axId));
  await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: axId, title: 'AX later', expectedVersion: axRow!.version }] },
    { repositoryId: advId, origin: 'user' },
  );
  await writePlanMirror(db, advId, advDir);
  await git(advDir, ['commit', '-q', '-am', 'plan later']);
  await git(advDir, ['push', '-q', 'origin', 'main']);
  await clearAdvBase();
  await advancePlanBaseFromCommit(db, advId, advDir, pushedX, 'main');
  check(
    'an older push never becomes the base once a later push changed plan.json',
    (await advBase()) === null,
    await advBase(),
  );
  await db.delete(schema.repositories).where(eq(schema.repositories.id, advId));

  /* --- 12.7 the three-way reconcile ---------------------------------------- */

  const sDir = path.join(holdRoot, 's');
  await mkdir(sDir, { recursive: true });
  const [sRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-three-way', source: 'blank', status: 'ready', storagePath: sDir })
    .returning();
  const sId = sRepo!.id;
  const sBuilt = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'sroot', parentRef: null, title: 'Root' },
        { op: 'upsert', nodeRef: 'sp', parentRef: 'sroot', title: 'P' },
        { op: 'upsert', nodeRef: 'sq', parentRef: 'sroot', title: 'Q' },
        { op: 'upsert', nodeRef: 'sr', parentRef: 'sroot', title: 'R' },
        { op: 'upsert', nodeRef: 'sr1', parentRef: 'sr', title: 'R1' },
      ],
    },
    { repositoryId: sId, origin: 'user' },
  );
  const [pId, qId, rId, r1Id] = ['sp', 'sq', 'sr', 'sr1'].map((r) => sBuilt.refs[r]!) as [
    string,
    string,
    string,
    string,
  ];
  await writePlanMirror(db, sId, sDir);
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: sBuilt.refs['sroot']! }] },
    { repositoryId: sId, origin: 'user' },
  );
  check(
    'three-way: the plan is restored from its checkout',
    (await importPlanMirror(db, sId, sDir)).imported,
  );
  const sPlanFile = path.join(sDir, HAIVE_DATA_FILES.plan);
  const readMirror = async () => JSON.parse(await readFile(sPlanFile, 'utf8')) as PlanMirror;
  let theirs = await readMirror();
  const arrive = async (next: PlanMirror, pretty = true) => {
    theirs = next;
    await writeFile(
      sPlanFile,
      pretty ? `${JSON.stringify(next, null, 2)}\n` : JSON.stringify(next),
    );
    return reconcilePlanFromCheckout(db, sId, sDir);
  };
  const retitled = (m: PlanMirror, id: string, title: string): PlanMirror => ({
    ...m,
    nodes: m.nodes.map((n) => (n.id === id ? { ...n, title } : n)),
  });
  const nodeRows = () =>
    db
      .select({
        id: schema.planNodes.id,
        title: schema.planNodes.title,
        status: schema.planNodes.status,
        version: schema.planNodes.version,
        doneAt: schema.planNodes.doneAt,
        updatedAt: schema.planNodes.updatedAt,
      })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, sId));
  const sNode = async (id: string) => (await nodeRows()).find((n) => n.id === id);
  const editS = async (id: string, set: { title?: string; status?: 'done' | 'todo' }) => {
    const row = await sNode(id);
    await applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: id, ...set, expectedVersion: row!.version }] },
      { repositoryId: sId, origin: 'user' },
    );
  };

  // A local title edit survives a pull in which the other side changed another node.
  await editS(pId, { title: 'P local' });
  const untouchedBefore = await nodeRows();
  const s1 = await arrive(retitled(theirs, qId, 'Q by A'));
  const s1After = await nodeRows();
  check(
    'three-way: a local title edit survives a pull where the other side changed another node',
    s1After.find((n) => n.id === pId)?.title === 'P local' &&
      s1After.find((n) => n.id === qId)?.title === 'Q by A',
    s1After,
  );
  check(
    'three-way: only the node that changed is updated, and no other version moves',
    s1.nodesUpdated === 1 &&
      s1After.every((n) => {
        const before = untouchedBefore.find((b) => b.id === n.id)!;
        return n.id === qId
          ? n.version === before.version + 1
          : n.version === before.version && n.updatedAt.getTime() === before.updatedAt.getTime();
      }),
    { s1, before: untouchedBefore, after: s1After },
  );

  // A pull with nothing new in it moves no version, whatever bytes it arrives in.
  const sameBefore = await nodeRows();
  const same = await arrive(theirs, false);
  const sameAfter = await nodeRows();
  check(
    'three-way: a pull that brings nothing new bumps no node version',
    same.nodesCreated === 0 &&
      same.nodesUpdated === 0 &&
      sameAfter.every((n) => n.version === sameBefore.find((b) => b.id === n.id)!.version),
    { same, sameBefore, sameAfter },
  );

  // An empty plan.json is never taken for the absence an older row stamped as the hash of zero bytes.
  const stampBefore = (
    await db.query.planMirrorState.findFirst({
      where: eq(schema.planMirrorState.repositoryId, sId),
    })
  )?.syncedHash;
  await db
    .update(schema.planMirrorState)
    .set({ syncedHash: createHash('sha256').update('').digest('hex') })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await writeFile(sPlanFile, '');
  await markPlanMirrorDirty(db, sId);
  const emptyHeld = await writePlanMirror(db, sId, sDir).then(
    () => 'wrote',
    (err: Error) => err.name,
  );
  check(
    'three-way: an empty plan.json is held, not taken for an absent one',
    emptyHeld === 'PlanMirrorHeldError' && (await readFile(sPlanFile, 'utf8')) === '',
    emptyHeld,
  );
  await db
    .update(schema.planMirrorState)
    .set({ syncedHash: stampBefore ?? null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await arrive(theirs);

  // A canvas edit that commits while a reconcile waits on its row wins; the reconcile holds.
  const qBefore = await sNode(qId);
  let racing: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit
      .update(schema.planNodes)
      .set({ title: 'Q edited on the canvas', version: qBefore!.version + 1 })
      .where(eq(schema.planNodes.id, qId));
    racing = arrive(retitled(theirs, qId, 'Q from the file')).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  check(
    'three-way: a canvas edit committed during a reconcile is kept and the reconcile holds',
    (await racing) === 'PlanMirrorHeldError' &&
      (await sNode(qId))?.title === 'Q edited on the canvas',
    await sNode(qId),
  );
  await writeFile(sPlanFile, JSON.stringify(retitled(theirs, qId, 'Q edited on the canvas')));
  await arrive(retitled(theirs, qId, 'Q edited on the canvas'));

  // A status the other side changed lands with its done_at, and leaving done clears it.
  const toDone = await arrive({
    ...theirs,
    nodes: theirs.nodes.map((n) => (n.id === qId ? { ...n, status: 'done' } : n)),
  });
  const qDone = await sNode(qId);
  check(
    'three-way: an imported status change to done stamps done_at',
    toDone.nodesUpdated === 1 && qDone?.status === 'done' && qDone.doneAt !== null,
    qDone,
  );
  await arrive({
    ...theirs,
    nodes: theirs.nodes.map((n) => (n.id === qId ? { ...n, status: 'todo' } : n)),
  });
  const qReopened = await sNode(qId);
  check(
    'three-way: an imported status change away from done clears done_at',
    qReopened?.status === 'todo' && qReopened.doneAt === null,
    qReopened,
  );

  // A node only here, added after the base, is not a deletion the other side made.
  const added = await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: 'tmp-n', parentRef: sBuilt.refs['sroot']!, title: 'N' }] },
    { repositoryId: sId, origin: 'user' },
  );
  const nId = added.created[0]!;
  await arrive(retitled(theirs, qId, 'Q again'));
  await arrive(retitled(theirs, qId, 'Q a third time'));
  check(
    'three-way: a node added here and never pushed survives two pulls that lack it',
    (await sNode(nId)) !== undefined,
  );
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: nId }] },
    { repositoryId: sId, origin: 'user' },
  );

  // The same field changed on both sides is asked, the database keeps its value and the file the other's.
  // The other side's file is this side's flushed render but for the one contested title.
  await editS(pId, { title: 'P local 2' });
  await writePlanMirror(db, sId, sDir);
  theirs = await readMirror();
  const asked = await arrive(retitled(theirs, pId, 'P by A'));
  const rowsAsked = await pendingPlanRows(sId);
  check(
    'three-way: a title changed on both sides leaves one pending plan row with the three sides',
    rowsAsked.length === 1 &&
      rowsAsked[0]!.unit === `plan/${pId}#title` &&
      JSON.stringify(rowsAsked[0]!.base) === '{"v":"P"}' &&
      JSON.stringify(rowsAsked[0]!.local) === '{"v":"P local 2"}' &&
      JSON.stringify(rowsAsked[0]!.incoming) === '{"v":"P by A"}' &&
      (asked.conflicts ?? []).length === 1,
    { rowsAsked, asked },
  );
  check('three-way: the database keeps its own title', (await sNode(pId))?.title === 'P local 2');
  const askedState = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, sId),
  });
  check(
    'three-way: a pull that only asks leaves the mirror dirty so plan.md is rewritten',
    !!askedState && askedState.revision > askedState.writtenRevision,
    askedState,
  );
  await writePlanMirror(db, sId, sDir);
  check(
    "three-way: the flush writes the other side's title into plan.json and the database's into plan.md",
    (await titleIn(sPlanFile, pId)) === 'P by A' &&
      (await readFile(path.join(sDir, HAIVE_DATA_FILES.planMarkdown), 'utf8')).includes(
        'P local 2',
      ) &&
      (await sNode(pId))?.title === 'P local 2',
  );
  await arrive(theirs, false);
  check(
    'three-way: asking again about the same change keeps one row',
    (await pendingPlanRows(sId)).length === 1,
  );
  const baseOf = async () =>
    (
      await db.query.planMirrorState.findFirst({
        where: eq(schema.planMirrorState.repositoryId, sId),
      })
    )?.syncedSnapshot as PlanMirror | null;
  await advancePlanBaseToPushed(
    db,
    sId,
    JSON.stringify(retitled(retitled(theirs, pId, 'P pushed'), qId, 'Q pushed')),
  );
  const pushedBase = await baseOf();
  check(
    'three-way: a push makes what it pushed the base, except a field still asked about',
    pushedBase?.nodes.find((n) => n.id === qId)?.title === 'Q pushed' &&
      pushedBase.nodes.find((n) => n.id === pId)?.title === 'P',
    pushedBase,
  );
  await editS(pId, { title: 'P by A' });
  await writePlanMirror(db, sId, sDir);
  check(
    'three-way: a local edit to the incoming value settles the question at the next flush',
    (await pendingPlanRows(sId)).length === 0,
  );
  check(
    'three-way: a settled question moves the base to the value both sides now hold',
    (await baseOf())?.nodes.find((n) => n.id === pId)?.title === 'P by A',
    await baseOf(),
  );
  await arrive(theirs);
  const closed = await db
    .select({ resolution: schema.projectStateConflicts.resolution })
    .from(schema.projectStateConflicts)
    .where(eq(schema.projectStateConflicts.unit, `plan/${pId}#title`));
  check(
    'three-way: a row closes as converged once the two sides agree',
    (await pendingPlanRows(sId)).length === 0 &&
      closed.length === 1 &&
      closed[0]!.resolution === 'converged',
    closed,
  );

  // A path repair waits on a row a canvas write holds, and holds once that write commits.
  const r1Before = await sNode(r1Id);
  let moving: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit
      .update(schema.planNodes)
      .set({ version: r1Before!.version + 1 })
      .where(eq(schema.planNodes.id, r1Id));
    moving = arrive({
      ...theirs,
      nodes: theirs.nodes.map((n) => (n.id === rId ? { ...n, parentId: pId } : n)),
    }).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const rAfterRace = (await nodeRows()).find((n) => n.id === rId);
  check(
    'three-way: a descendant path repair racing a canvas write holds and moves nothing',
    (await moving) === 'PlanMirrorHeldError' &&
      (
        await db
          .select({ parentId: schema.planNodes.parentId })
          .from(schema.planNodes)
          .where(eq(schema.planNodes.id, rId))
      )[0]?.parentId !== pId,
    rAfterRace,
  );
  await arrive({
    ...theirs,
    nodes: theirs.nodes.map((n) => (n.id === rId ? { ...n, parentId: sBuilt.refs['sroot']! } : n)),
  });

  // A node the other side deleted and nobody here touched is deleted here, its subtree with it.
  await db.insert(schema.planNodeEdges).values({
    repositoryId: sId,
    fromNodeId: pId,
    toNodeId: r1Id,
    kind: 'affects',
  });
  // An edge note a canvas write holds is not overwritten by the reconcile, which holds instead.
  await writePlanMirror(db, sId, sDir);
  theirs = await readMirror();
  await advancePlanBaseToPushed(db, sId, await readFile(sPlanFile, 'utf8'));
  let noting: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit
      .update(schema.planNodeEdges)
      .set({ note: 'from the canvas' })
      .where(eq(schema.planNodeEdges.repositoryId, sId));
    noting = arrive({
      ...theirs,
      edges: theirs.edges.map((e) => (e.toNodeId === r1Id ? { ...e, note: 'from the file' } : e)),
    }).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const notes = await db
    .select({ note: schema.planNodeEdges.note })
    .from(schema.planNodeEdges)
    .where(eq(schema.planNodeEdges.repositoryId, sId));
  check(
    'three-way: an edge a canvas write changed during a reconcile keeps its note and the reconcile holds',
    (await noting) === 'PlanMirrorHeldError' &&
      notes.length === 1 &&
      notes[0]!.note === 'from the canvas',
    { notes },
  );
  await arrive({
    ...theirs,
    edges: theirs.edges.map((e) => (e.toNodeId === r1Id ? { ...e, note: 'from the canvas' } : e)),
  });
  // An edge a canvas patch inserts while the reconcile adds the same one holds the reconcile.
  let edging: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit.insert(schema.planNodeEdges).values({
      repositoryId: sId,
      fromNodeId: pId,
      toNodeId: r1Id,
      kind: 'depends_on',
      note: 'from the canvas',
    });
    edging = arrive({
      ...theirs,
      edges: [
        ...theirs.edges,
        { fromNodeId: pId, toNodeId: r1Id, kind: 'depends_on', note: 'from the file' },
      ],
    }).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const depends = await db
    .select({ note: schema.planNodeEdges.note })
    .from(schema.planNodeEdges)
    .where(
      and(eq(schema.planNodeEdges.repositoryId, sId), eq(schema.planNodeEdges.kind, 'depends_on')),
    );
  check(
    'three-way: an edge a canvas patch inserted during the reconcile keeps its note and holds the reconcile',
    (await edging) === 'PlanMirrorHeldError' &&
      depends.length === 1 &&
      depends[0]!.note === 'from the canvas',
    { edging: await edging, depends },
  );
  await db
    .delete(schema.planNodeEdges)
    .where(
      and(eq(schema.planNodeEdges.repositoryId, sId), eq(schema.planNodeEdges.kind, 'depends_on')),
    );
  await arrive(theirs);

  // A child a canvas patch adds under a node the other side deleted is not taken by the cascade.
  let childId: string | undefined;
  let dropping: Promise<string> | undefined;
  const dropFile = {
    ...theirs,
    nodes: theirs.nodes.filter((n) => n.id !== rId && n.id !== r1Id),
    edges: theirs.edges.filter((e) => e.toNodeId !== r1Id),
  };
  await db.transaction(async (edit) => {
    const added = await applyPlanPatch(
      edit,
      { ops: [{ op: 'upsert', nodeRef: 'tmp-late-child', parentRef: rId, title: 'Late child' }] },
      { repositoryId: sId, origin: 'user' },
    );
    childId = added.created[0];
    dropping = arrive(dropFile).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  check(
    'three-way: a child added under a node being deleted holds the reconcile and survives',
    (await dropping) === 'PlanMirrorHeldError' && (await sNode(childId!)) !== undefined,
    await dropping,
  );
  await applyPlanPatch(
    db,
    {
      ops: [{ op: 'delete', nodeRef: childId!, expectedVersion: (await sNode(childId!))!.version }],
    },
    { repositoryId: sId, origin: 'user' },
  );
  const dropR = await arrive({
    ...theirs,
    nodes: theirs.nodes.filter((n) => n.id !== rId && n.id !== r1Id),
    edges: theirs.edges.filter((e) => e.toNodeId !== r1Id),
  });
  const afterDrop = await nodeRows();
  check(
    'three-way: an untouched node the other side deleted is deleted here, deepest first',
    !afterDrop.some((n) => n.id === rId || n.id === r1Id) &&
      JSON.stringify(dropR.nodesDeleted) === JSON.stringify([r1Id, rId]),
    { dropR, afterDrop },
  );
  check(
    'three-way: the links of a deleted node go with it',
    (
      await db
        .select({ id: schema.planNodeEdges.id })
        .from(schema.planNodeEdges)
        .where(eq(schema.planNodeEdges.repositoryId, sId))
    ).length === 0,
  );

  // A checkout that reached this plan's bytes on its own agrees with it, so that becomes the base.
  await editS(qId, { title: 'Q reached on both sides' });
  await writePlanMirror(db, sId, sDir);
  await db
    .update(schema.planMirrorState)
    .set({ syncedHash: 'stamped-before-the-other-side-agreed' })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await markPlanMirrorDirty(db, sId);
  await writePlanMirror(db, sId, sDir);
  check(
    'three-way: plan.json that independently equals the render moves the base to it',
    (await baseOf())?.nodes.find((n) => n.id === qId)?.title === 'Q reached on both sides',
    await baseOf(),
  );
  theirs = await readMirror();

  // A question whose node is deleted here closes.
  await editS(qId, { title: 'Q local, soon gone' });
  await arrive(retitled(theirs, qId, 'Q remote, soon gone'));
  const askedBeforeGone = (await pendingPlanRows(sId)).length;
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: qId, expectedVersion: (await sNode(qId))!.version }] },
    { repositoryId: sId, origin: 'user' },
  );
  await writePlanMirror(db, sId, sDir);
  check(
    'three-way: a question whose node was deleted here closes at the next flush',
    askedBeforeGone === 1 && (await pendingPlanRows(sId)).length === 0,
    askedBeforeGone,
  );

  // A file whose plan has another root shares no history with this one, and deletes nothing here.
  const beforeReplace = await nodeRows();
  await writeFile(
    sPlanFile,
    JSON.stringify({
      ...theirs,
      nodes: [{ ...theirs.nodes.find((n) => n.parentId === null)!, id: randomUUID() }],
      edges: [],
      codeLinks: [],
    }),
  );
  const replaced = await reconcilePlanFromCheckout(db, sId, sDir).then(
    () => 'merged',
    (err: Error) => err.name,
  );
  check(
    'three-way: a plan with a different root is refused and nothing here is deleted',
    replaced === 'PlanSnapshotError' && (await nodeRows()).length === beforeReplace.length,
    { replaced },
  );
  // A rescan that meets the same refused file keeps the reason and leaves the row for the sweep.
  await db
    .update(schema.planMirrorState)
    .set({ lastError: null, writtenRevision: sql`${schema.planMirrorState.revision}` })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await persistDetection(db, sId, sDir);
  const rescanned = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, sId),
  });
  check(
    'three-way: a rescan whose reconcile is refused records why and leaves the mirror dirty',
    !!rescanned?.lastError?.includes('different root') &&
      rescanned.revision > rescanned.writtenRevision,
    rescanned,
  );
  await arrive(theirs);

  // Before a Pull moves the checkout, a stamped row with no base takes the file on disk as its base.
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await seedPlanBaseFromCheckout(db, sId, sDir);
  check(
    'three-way: a Pull seeds a missing base from the stamped file first',
    (await baseOf()) != null,
  );

  // A row stamped before 0196 takes the bytes it already read as its base.
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await reconcilePlanFromCheckout(db, sId, sDir);
  check(
    'three-way: a stamped row with no base takes the unchanged file as its base',
    (await baseOf()) != null,
  );

  // The same row, if a local edit is flushed first, keeps the file before the edit as its base.
  const pBeforeFlush = (await sNode(pId))?.title;
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await editS(pId, { title: 'P edited before any pull' });
  await writePlanMirror(db, sId, sDir);
  check(
    'three-way: a flush on a row with no base stores the file it is about to replace as the base',
    (await baseOf())?.nodes.find((n) => n.id === pId)?.title === pBeforeFlush,
    await baseOf(),
  );
  theirs = await readMirror();

  // A rescan with no base and edits not yet written out holds rather than letting incoming win.
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null, lastError: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await editS(pId, { title: 'P unwritten before a rescan' });
  await writeFile(sPlanFile, JSON.stringify(retitled(theirs, pId, 'P from the rescan')));
  await persistDetection(db, sId, sDir);
  const rescanHeld = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, sId),
  });
  check(
    'three-way: a rescan with no base holds instead of overwriting an unwritten edit',
    (await sNode(pId))?.title === 'P unwritten before a rescan' &&
      !!rescanHeld?.lastError?.includes('no earlier copy'),
    { title: (await sNode(pId))?.title, lastError: rescanHeld?.lastError },
  );
  await arrive(retitled(theirs, pId, 'P unwritten before a rescan'));

  // A plan.json that is not JSON is refused with a reason, not skipped as absent.
  await writeFile(sPlanFile, '{ not json');
  const notJson = await reconcilePlanFromCheckout(db, sId, sDir).then(
    () => 'merged',
    (err: Error) => `${err.name}: ${err.message}`,
  );
  check(
    'three-way: a plan.json that is not JSON is refused',
    notJson.startsWith('PlanSnapshotError') && notJson.includes('not valid JSON'),
    notJson,
  );
  await db
    .update(schema.planMirrorState)
    .set({ lastError: null, writtenRevision: sql`${schema.planMirrorState.revision}` })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await persistDetection(db, sId, sDir);
  const malformedRescan = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, sId),
  });
  check(
    'three-way: a rescan of a plan that exists records a non-JSON plan.json and leaves it dirty',
    !!malformedRescan?.lastError?.includes('not valid JSON') &&
      malformedRescan.revision > malformedRescan.writtenRevision,
    malformedRescan,
  );
  await arrive(theirs);

  // No base: the incoming side wins and nothing is deleted, as a reconcile always did.
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await editS(pId, { title: 'P edited with no base' });
  await arrive(retitled(theirs, pId, 'P by A, no base'));
  check(
    'three-way: with no base the incoming title wins',
    (await sNode(pId))?.title === 'P by A, no base' && (await pendingPlanRows(sId)).length === 0,
  );

  // A flush with no base and unwritten edits of its own holds rather than guess which side is newer.
  await db
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: null })
    .where(eq(schema.planMirrorState.repositoryId, sId));
  await editS(pId, { title: 'P unwritten' });
  const external = retitled(theirs, qId, 'Q external');
  await writeFile(sPlanFile, JSON.stringify(external), 'utf8');
  const heldNoBase = await writePlanMirror(db, sId, sDir).then(
    () => 'wrote',
    (err: Error) => err.name,
  );
  check(
    'three-way: a flush with no base and unwritten local edits holds and keeps both sides',
    heldNoBase === 'PlanMirrorHeldError' &&
      (await readFile(sPlanFile, 'utf8')) === JSON.stringify(external) &&
      (await sNode(pId))?.title === 'P unwritten',
    heldNoBase,
  );
  await arrive(external);

  // A deletion the other side made loses to an edit here, and the outcome says so.
  const xAdded = await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: 'tmp-x', parentRef: sBuilt.refs['sroot']!, title: 'X' }] },
    { repositoryId: sId, origin: 'user' },
  );
  const xId = xAdded.created[0]!;
  await writePlanMirror(db, sId, sDir);
  theirs = await readMirror();
  await advancePlanBaseToPushed(db, sId, await readFile(sPlanFile, 'utf8'));
  await editS(xId, { title: 'X edited here' });
  const xKept = await arrive({ ...theirs, nodes: theirs.nodes.filter((n) => n.id !== xId) });
  check(
    'three-way: a deletion lost to a local edit is reported in the outcome',
    (await sNode(xId)) !== undefined &&
      (xKept.reported ?? []).some(
        (r) => r.kind === 'kept-modified' && r.subject === xId && r.deletedBy === 'incoming',
      ),
    xKept.reported,
  );
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: xId, expectedVersion: (await sNode(xId))!.version }] },
    { repositoryId: sId, origin: 'user' },
  );

  // A node both sides added with different titles stays out of the base, with its new subtree, so
  // the question survives an unrelated pull.
  const yAdded = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'tmp-y', parentRef: sBuilt.refs['sroot']!, title: 'Y' },
        { op: 'upsert', nodeRef: 'tmp-y1', parentRef: 'tmp-y', title: 'Y1' },
      ],
    },
    { repositoryId: sId, origin: 'user' },
  );
  const yId = yAdded.refs['tmp-y']!;
  const y1Id = yAdded.refs['tmp-y1']!;
  const zAdded = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'tmp-w', parentRef: sBuilt.refs['sroot']!, title: 'W' },
        { op: 'upsert', nodeRef: 'tmp-z', parentRef: 'tmp-w', title: 'Z' },
      ],
    },
    { repositoryId: sId, origin: 'user' },
  );
  const wId = zAdded.refs['tmp-w']!;
  const zId = zAdded.refs['tmp-z']!;
  await writePlanMirror(db, sId, sDir);
  const withY = await readMirror();
  const withoutY = {
    ...withY,
    nodes: withY.nodes.filter((n) => n.id !== yId && n.id !== y1Id),
  };
  theirs = withoutY;
  await advancePlanBaseToPushed(db, sId, JSON.stringify(withoutY));
  await editS(yId, { title: 'Y here' });
  // The other side also moved Z, which is in the base, under its own Y, and deleted Z's old parent W.
  await arrive({
    ...retitled(withY, yId, 'Y there'),
    nodes: retitled(withY, yId, 'Y there')
      .nodes.filter((n) => n.id !== wId)
      .map((n) => (n.id === zId ? { ...n, parentId: yId } : n)),
  });
  const yBase = await baseOf();
  check(
    'three-way: an old node moved under a node both sides added keeps its old place in the base, its deleted old parent with it',
    !yBase?.nodes.some((n) => n.id === yId) &&
      yBase?.nodes.find((n) => n.id === zId)?.parentId === wId &&
      yBase?.nodes.some((n) => n.id === wId) === true,
    yBase?.nodes.map((n) => [n.id, n.parentId]),
  );
  await arrive({
    ...theirs,
    nodes: theirs.nodes.map((n) => (n.parentId === null ? { ...n, body: 'unrelated change' } : n)),
  });
  check(
    'three-way: a node added on both sides with different titles stays out of the base and stays asked',
    !yBase?.nodes.some((n) => n.id === yId || n.id === y1Id) &&
      (await pendingPlanRows(sId)).some((r) => r.unit === `plan/${yId}#title`),
    { yBase: yBase?.nodes.map((n) => n.id), rows: await pendingPlanRows(sId) },
  );

  // A canvas edit that lands while a question is being settled keeps it open.
  await editS(yId, { title: 'Y there' });
  let settling: Promise<unknown> | undefined;
  await db.transaction(async (edit) => {
    await edit
      .update(schema.planNodes)
      .set({ title: 'Y third' })
      .where(eq(schema.planNodes.id, yId));
    settling = writePlanMirror(db, sId, sDir).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  await settling;
  check(
    'three-way: a question is not settled on a value a concurrent edit replaced',
    (await pendingPlanRows(sId)).some((r) => r.unit === `plan/${yId}#title`) &&
      (await sNode(yId))?.title === 'Y third',
    await pendingPlanRows(sId),
  );
  check(
    "three-way: a question shows this side's current value after it moved to a third one",
    (await pendingPlanRows(sId)).some(
      (r) => r.unit === `plan/${yId}#title` && JSON.stringify(r.local) === '{"v":"Y third"}',
    ),
    await pendingPlanRows(sId),
  );

  // Settled on the incoming value, the question closes; the node stays out of the base, since only
  // the asked field is known to be shared.
  await editS(yId, { title: 'Y there' });
  await writePlanMirror(db, sId, sDir);
  check(
    'three-way: a settled question on a node both sides added closes and keeps it out of the base',
    !(await pendingPlanRows(sId)).some((r) => r.unit === `plan/${yId}#title`) &&
      !(await baseOf())?.nodes.some((n) => n.id === yId || n.id === y1Id),
    await baseOf(),
  );
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: yId, expectedVersion: (await sNode(yId))!.version }] },
    { repositoryId: sId, origin: 'user' },
  );
  await writePlanMirror(db, sId, sDir);
  theirs = await readMirror();

  // A question is not recorded on a local value a canvas edit replaced during the reconcile.
  await editS(pId, { title: 'P race local' });
  const pRace = await sNode(pId);
  let asking: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit
      .update(schema.planNodes)
      .set({ title: 'P on the canvas', version: pRace!.version + 1 })
      .where(eq(schema.planNodes.id, pId));
    asking = arrive(retitled(theirs, pId, 'P race remote')).then(
      () => 'merged',
      (err: Error) => err.name,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const raceRows = await pendingPlanRows(sId);
  check(
    'three-way: a question is not recorded on a value a concurrent edit replaced',
    (await asking) === 'PlanMirrorHeldError' &&
      !raceRows.some(
        (r) => r.unit === `plan/${pId}#title` && JSON.stringify(r.local) === '{"v":"P race local"}',
      ),
    { asking: await asking, raceRows },
  );

  // A merge opened while the reconcile waits holds it: an abort could take back what it read.
  await git(sDir, ['init', '-q', '-b', 'main']);
  let duringMerge: Promise<string> | undefined;
  await db.transaction(async (edit) => {
    await edit.select().from(schema.planNodes).where(eq(schema.planNodes.id, pId)).for('update');
    duringMerge = arrive(retitled(theirs, pId, 'P while merging')).then(
      () => 'merged',
      (err: Error) => err.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(path.join(sDir, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);
  });
  check(
    'three-way: a merge that opens during the reconcile holds it before it commits',
    /merge or rebase/.test((await duringMerge) ?? '') &&
      (await sNode(pId))?.title !== 'P while merging',
    { duringMerge: await duringMerge, title: (await sNode(pId))?.title },
  );
  await rm(path.join(sDir, '.git'), { recursive: true, force: true });

  // Deleting the plan closes its questions and drops the base.
  await editS(pId, { title: 'P local 3' });
  await arrive(retitled(theirs, pId, 'P by A 3'));
  await arrive(retitled(theirs, pId, 'P by A 4'));
  const askedAgain = (await pendingPlanRows(sId)).length;
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: sBuilt.refs['sroot']! }] },
    { repositoryId: sId, origin: 'user' },
  );
  // With no plan left here the base's root still names this plan, so another root is refused.
  const beforeWipe = await readFile(sPlanFile);
  await writeFile(
    sPlanFile,
    JSON.stringify({
      ...theirs,
      nodes: [{ ...theirs.nodes.find((n) => n.parentId === null)!, id: randomUUID() }],
      edges: [],
      codeLinks: [],
    }),
  );
  const wipedForeign = await reconcilePlanFromCheckout(db, sId, sDir).then(
    () => 'merged',
    (err: Error) => err.name,
  );
  check(
    'three-way: with no plan here, a plan with a root other than the base is refused',
    wipedForeign === 'PlanSnapshotError' && (await nodeRows()).length === 0,
    wipedForeign,
  );
  await writeFile(sPlanFile, beforeWipe);
  await writePlanMirror(db, sId, sDir);
  const afterWipe = await db.query.planMirrorState.findFirst({
    where: eq(schema.planMirrorState.repositoryId, sId),
  });
  check(
    'three-way: deleting the plan closes its plan rows and clears the base',
    askedAgain === 1 &&
      (await pendingPlanRows(sId)).length === 0 &&
      afterWipe?.syncedSnapshot === null,
    { askedAgain, afterWipe },
  );
  await db.delete(schema.repositories).where(eq(schema.repositories.id, sId));

  /* --- 12.7b answering a plan question ------------------------------------- */

  const paDir = path.join(holdRoot, 'answer');
  await mkdir(paDir, { recursive: true });
  const [paRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-answer', source: 'blank', status: 'ready', storagePath: paDir })
    .returning();
  const paId = paRepo!.id;
  const paBuilt = await applyPlanPatch(
    db,
    {
      ops: [
        { op: 'upsert', nodeRef: 'aroot', parentRef: null, title: 'Root' },
        { op: 'upsert', nodeRef: 'ax', parentRef: 'aroot', title: 'X' },
        { op: 'upsert', nodeRef: 'ay', parentRef: 'aroot', title: 'Y' },
        { op: 'upsert', nodeRef: 'az', parentRef: 'aroot', title: 'Z' },
      ],
    },
    { repositoryId: paId, origin: 'user' },
  );
  const [paXId, paYId, paZId] = ['ax', 'ay', 'az'].map((r) => paBuilt.refs[r]!) as [
    string,
    string,
    string,
  ];
  await writePlanMirror(db, paId, paDir);
  await seedPlanBaseFromCheckout(db, paId, paDir);
  const paFile = path.join(paDir, HAIVE_DATA_FILES.plan);
  const paANodes = () =>
    db
      .select({
        id: schema.planNodes.id,
        title: schema.planNodes.title,
        version: schema.planNodes.version,
      })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, paId));
  const paNode = async (id: string) => (await paANodes()).find((n) => n.id === id);
  const retitle = async (id: string, title: string) => {
    await applyPlanPatch(
      db,
      { ops: [{ op: 'upsert', nodeRef: id, title, expectedVersion: (await paNode(id))!.version }] },
      { repositoryId: paId, origin: 'user' },
    );
  };
  const paTheirs = async (id: string, title: string): Promise<PlanMirror> => {
    const mirror = JSON.parse(await readFile(paFile, 'utf8')) as PlanMirror;
    return { ...mirror, nodes: mirror.nodes.map((n) => (n.id === id ? { ...n, title } : n)) };
  };
  const paArrive = async (next: PlanMirror) => {
    await writeFile(paFile, `${JSON.stringify(next, null, 2)}\n`);
    return reconcilePlanFromCheckout(db, paId, paDir);
  };
  const paRowFor = async (nodeId: string) =>
    (await pendingPlanRows(paId)).find((r) => r.unit === `plan/${nodeId}#title`);
  const answerRow = async (row: { id: string } | undefined, answer: 'keep_mine' | 'take_theirs') =>
    resolveProjectStateConflict(db, {
      repositoryId: paId,
      userId,
      conflictId: row?.id ?? randomUUID(),
      answer,
    });
  const forceMerge = () =>
    db
      .update(schema.planMirrorState)
      .set({ syncedHash: 'forced-merge' })
      .where(eq(schema.planMirrorState.repositoryId, paId));

  await retitle(paXId, 'X local');
  await writePlanMirror(db, paId, paDir);
  await paArrive(await paTheirs(paXId, 'X by A'));
  const xRow = await paRowFor(paXId);
  check('plan answer: a title changed on both sides is a pending plan row', xRow !== undefined);

  const paUnits = await pendingConflictUnits(db, paId);
  const paAdmission = await upgradeAdmission(db, userId, {
    id: paId,
    source: 'blank',
    renderContext: null,
    status: 'ready',
    storagePath: paDir,
    localPath: null,
    onboardedAt: null,
    onboardingResetAt: null,
  });
  check(
    'plan answer: a pending plan row holds no upgrade or admission',
    paUnits.includes(`plan/${paXId}#title`) &&
      paUnits.filter(blocksUpgrade).length === 0 &&
      !(!paAdmission.admitted && paAdmission.reason === 'contested'),
    { paUnits, paAdmission },
  );

  await retitle(paXId, 'X local 2');
  const staleAnswer = await answerRow(xRow, 'take_theirs');
  const staleRow = await paRowFor(paXId);
  check(
    'plan answer: a stale answer (edited since asked) is moved, changes nothing and re-asks with the current value',
    staleAnswer.kind === 'moved' &&
      (await paNode(paXId))?.title === 'X local 2' &&
      staleRow !== undefined &&
      JSON.stringify(staleRow.local) === '{"v":"X local 2"}',
    { staleAnswer, staleRow },
  );

  const paSource = async (id: string) =>
    (
      await db
        .select({ sourceTaskId: schema.planNodes.sourceTaskId })
        .from(schema.planNodes)
        .where(eq(schema.planNodes.id, id))
    )[0]?.sourceTaskId;
  const markBuilt = (id: string) =>
    db
      .update(schema.planNodes)
      .set({ sourceTaskId: linkTaskId })
      .where(eq(schema.planNodes.id, id));
  await markBuilt(paXId);
  const xBefore = await paNode(paXId);
  const taken = await answerRow(xRow, 'take_theirs');
  const xAfter = await paNode(paXId);
  check(
    "plan answer: take theirs sets the node to the other side's title and bumps its version",
    taken.kind === 'resolved' &&
      xAfter?.title === 'X by A' &&
      xAfter.version === xBefore!.version + 1 &&
      (await paRowFor(paXId)) === undefined,
    { taken, xBefore, xAfter },
  );
  check(
    'plan answer: take theirs clears the plan build provenance, as a canvas edit does',
    (await paSource(paXId)) === null,
    await paSource(paXId),
  );
  check(
    'plan answer: the flush after take theirs writes the title into plan.json',
    (await titleIn(paFile, paXId)) === 'X by A',
  );
  const takenRowAfter = await db.query.projectStateConflicts.findFirst({
    where: eq(schema.projectStateConflicts.id, xRow!.id),
  });
  check(
    'plan answer: the answered row records the answer',
    takenRowAfter?.resolution === 'take_theirs' && takenRowAfter.resolvedBy === userId,
    takenRowAfter,
  );
  const versionsBeforeAgain = await paANodes();
  await forceMerge();
  const againTaken = await reconcilePlanFromCheckout(db, paId, paDir);
  check(
    'plan answer: a reconcile of the same file after take theirs changes nothing and asks nothing',
    againTaken.nodesUpdated === 0 &&
      (againTaken.conflicts ?? []).length === 0 &&
      (await pendingPlanRows(paId)).length === 0 &&
      JSON.stringify(await paANodes()) === JSON.stringify(versionsBeforeAgain),
    { againTaken, versions: await paANodes() },
  );

  await retitle(paYId, 'Y local');
  await writePlanMirror(db, paId, paDir);
  await paArrive(await paTheirs(paYId, 'Y by A'));
  const yRow = await paRowFor(paYId);
  const yBefore = await paNode(paYId);
  const kept = await answerRow(yRow, 'keep_mine');
  check(
    'plan answer: keep mine leaves the node as it is',
    yRow !== undefined &&
      kept.kind === 'resolved' &&
      (await paNode(paYId))?.title === 'Y local' &&
      (await paNode(paYId))?.version === yBefore!.version &&
      (await paRowFor(paYId)) === undefined,
    { kept, yBefore, now: await paNode(paYId) },
  );
  check(
    'plan answer: the flush after keep mine writes the local title into plan.json',
    (await titleIn(paFile, paYId)) === 'Y local',
    await titleIn(paFile, paYId),
  );
  const stillTheirs = await paArrive(await paTheirs(paYId, 'Y by A'));
  check(
    "plan answer: the other side's unchanged file after keep mine keeps the local title without asking",
    stillTheirs.nodesUpdated === 0 &&
      (stillTheirs.conflicts ?? []).length === 0 &&
      (await pendingPlanRows(paId)).length === 0 &&
      (await paNode(paYId))?.title === 'Y local',
    { stillTheirs, node: await paNode(paYId) },
  );
  await writePlanMirror(db, paId, paDir);
  const yVersions = await paANodes();
  await forceMerge();
  const againKept = await reconcilePlanFromCheckout(db, paId, paDir);
  check(
    'plan answer: a reconcile of the flushed file after keep mine changes nothing and asks nothing',
    againKept.nodesUpdated === 0 &&
      (againKept.conflicts ?? []).length === 0 &&
      (await pendingPlanRows(paId)).length === 0 &&
      JSON.stringify(await paANodes()) === JSON.stringify(yVersions),
    { againKept, versions: await paANodes() },
  );

  await markBuilt(paYId);
  await paArrive(await paTheirs(paYId, 'Y remote 2'));
  check(
    'three-way: a node the other side changed loses the plan build provenance, as a canvas edit does',
    (await paNode(paYId))?.title === 'Y remote 2' && (await paSource(paYId)) === null,
    { node: await paNode(paYId), source: await paSource(paYId) },
  );

  await retitle(paZId, 'Z local');
  await writePlanMirror(db, paId, paDir);
  await paArrive(await paTheirs(paZId, 'Z by A'));
  const zRow = await paRowFor(paZId);
  await applyPlanPatch(
    db,
    { ops: [{ op: 'delete', nodeRef: paZId }] },
    { repositoryId: paId, origin: 'user' },
  );
  const goneAnswer = await answerRow(zRow, 'take_theirs');
  const zClosed = await db.query.projectStateConflicts.findFirst({
    where: eq(schema.projectStateConflicts.id, zRow!.id),
  });
  check(
    'plan answer: a question whose node is gone closes as converged',
    zRow !== undefined &&
      goneAnswer.kind === 'settled' &&
      zClosed?.resolution === 'converged' &&
      zClosed.resolvedAt !== null,
    { goneAnswer, zClosed },
  );
  const wrongOwner = await resolveProjectStateConflict(db, {
    repositoryId: paId,
    userId: randomUUID(),
    conflictId: xRow!.id,
    answer: 'take_theirs',
  });
  check('plan answer: another user gets nothing', wrongOwner.kind === 'not_found', wrongOwner);
  await db.delete(schema.repositories).where(eq(schema.repositories.id, paId));

  const mergingDir = path.join(holdRoot, 'import-merging');
  await mkdir(path.dirname(path.join(mergingDir, HAIVE_DATA_FILES.plan)), { recursive: true });
  await writeFile(path.join(mergingDir, HAIVE_DATA_FILES.plan), beforeWipe);
  await git(mergingDir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(mergingDir, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);
  const [mergingRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-import-merging', source: 'blank', status: 'ready' })
    .returning();
  const mergingImport = await importPlanMirror(db, mergingRepo!.id, mergingDir).then(
    () => 'imported',
    (err: Error) => err.message,
  );
  const mergingNodes = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, mergingRepo!.id));
  check(
    'an import while a merge is open reads nothing in',
    /merge or rebase/.test(mergingImport) && mergingNodes.length === 0,
    { mergingImport, nodes: mergingNodes.length },
  );
  await db.delete(schema.repositories).where(eq(schema.repositories.id, mergingRepo!.id));

  await db.delete(schema.repositories).where(eq(schema.repositories.id, holdId));
  await rm(holdRoot, { recursive: true, force: true }).catch(() => {});

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

  /* --- 20. clarify rounds: the guarantees only a real Postgres can give ---- */

  const [clarifyRepo] = await db
    .insert(schema.repositories)
    .values({ userId, name: 'plan-smoke-clarify', source: 'blank', status: 'ready' })
    .returning();
  const clarifyBuilt = await applyPlanPatch(
    db,
    { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Clarify root' }] },
    { repositoryId: clarifyRepo!.id, origin: 'llm' },
  );
  const clarifyRootId = clarifyBuilt.created[0]!;
  const clarifyTasks = await db
    .insert(schema.tasks)
    .values(
      ['a', 'b'].map((suffix) => ({
        userId,
        type: 'workflow' as const,
        title: `plan-smoke clarify fixture ${suffix}`,
        repositoryId: clarifyRepo!.id,
        status: 'running' as const,
      })),
    )
    .returning();
  const [clarifyTaskA, clarifyTaskB] = clarifyTasks;
  const roundsOf = async (taskId: string) =>
    db
      .select({ id: schema.planClarifyRounds.id, rootId: schema.planClarifyRounds.rootId })
      .from(schema.planClarifyRounds)
      .where(eq(schema.planClarifyRounds.taskId, taskId));

  await db
    .insert(schema.planClarifyRounds)
    .values({ taskId: clarifyTaskA!.id, round: 0, rootId: clarifyRootId });
  await db.insert(schema.planClarifyRounds).values({ taskId: clarifyTaskA!.id, round: 1 });
  await db
    .insert(schema.planClarifyRounds)
    .values({ taskId: clarifyTaskB!.id, round: 0, rootId: clarifyRootId });

  let duplicateCode: unknown;
  try {
    await db.insert(schema.planClarifyRounds).values({ taskId: clarifyTaskA!.id, round: 1 });
  } catch (err) {
    duplicateCode =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  }
  check('a second row for the same task and round is refused', duplicateCode === '23505', {
    duplicateCode,
    rows: (await roundsOf(clarifyTaskA!.id)).length,
  });

  await db.delete(schema.planNodes).where(eq(schema.planNodes.id, clarifyRootId));
  const afterRootDelete = await roundsOf(clarifyTaskA!.id);
  check(
    'deleting the plan root keeps the round and nulls its root_id',
    afterRootDelete.length === 2 && afterRootDelete.every((r) => r.rootId === null),
    afterRootDelete,
  );

  await db.delete(schema.tasks).where(eq(schema.tasks.id, clarifyTaskA!.id));
  check(
    'deleting the task deletes its rounds',
    (await roundsOf(clarifyTaskA!.id)).length === 0,
    await roundsOf(clarifyTaskA!.id),
  );
  check(
    "another task's rounds are untouched",
    (await roundsOf(clarifyTaskB!.id)).length === 1,
    await roundsOf(clarifyTaskB!.id),
  );

  await db.delete(schema.tasks).where(eq(schema.tasks.id, clarifyTaskB!.id));
  await db.delete(schema.repositories).where(eq(schema.repositories.id, clarifyRepo!.id));
}

main()
  .then(() => {
    if (failures.length > 0) {
      log.error({ failures }, `[smoke] ${failures.length} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    log.info('[smoke] plan-canvas smoke passed');
    console.log(JSON.stringify({ smoke: 'PLAN_CANVAS_OK' }));
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
