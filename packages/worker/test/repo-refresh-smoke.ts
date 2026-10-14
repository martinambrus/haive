/**
 * A refresh fast-forwards a checkout to its source and never deletes one, against a database and
 * real git repositories. One throwaway user and temp directory, deleted after.
 */
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as isDeepEqual } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@haive/database';
import { HAIVE_DATA_FILES, logger, type RepoJobPayload } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { initDatabase, getDb } from '../src/db.js';
import { StepSupersededError } from '../src/step-engine/step-ownership.js';
import { handleClone, handleCopyLocal } from '../src/repo/clone.js';
import { checkoutHoldingTasks, handleRefresh } from '../src/repo/refresh.js';
import {
  putBackProjections,
  recoverAfterMoveFailure,
  restoreFaults,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
} from '../src/project-state/set-aside.js';
import { lockProjectState, writeProjectStateColumn } from '../src/project-state/write.js';
import { sweepDirtyProjectStates } from '../src/project-state/refresh.js';
import { writePlanMirror } from '../src/plan/mirror.js';
import { syncBaseStep } from '../src/step-engine/steps/workflow/00a-sync-base.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const log = logger.child({ module: 'repo-refresh-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'gc.auto=0', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const hasCommit = (cwd: string, sha: string): boolean => {
  try {
    git(cwd, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
async function commitFile(repo: string, file: string, body: string, message: string) {
  await writeFile(path.join(repo, file), body);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const tmp = await mkdtemp(path.join(tmpdir(), 'repo-refresh-smoke-'));
  const storage = path.join(tmp, 'storage');
  await mkdir(storage);
  const userId = randomUUID();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'repo-refresh-smoke',
      emailBlindIndex: `repo-refresh-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
    const statusOf = async (id: string) =>
      (await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { status: true, statusMessage: true },
      }))!;

    // One bare remote and a seed clone that pushes to it.
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', `file://${origin}`, seed);
    await commitFile(seed, 'README.md', 'seed\n', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const push = async (file: string, body: string) => {
      const sha = await commitFile(seed, file, body, `update ${file}`);
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      return sha;
    };

    const cloned = async (from = origin) => {
      const remoteUrl = `file://${from}`;
      const [row] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'repo-refresh-smoke',
          source: 'git_https',
          remoteUrl,
          branch: 'main',
        })
        .returning({ id: schema.repositories.id });
      const payload: RepoJobPayload = {
        repositoryId: row!.id,
        userId,
        source: 'git_https',
        remoteUrl,
        branch: 'main',
      };
      await handleClone(payload, db, storage);
      return { payload, dest: path.join(storage, userId, row!.id) };
    };

    // 1. An unpushed commit is refused, not re-cloned away.
    {
      const { payload, dest } = await cloned();
      const local = await commitFile(dest, 'local.txt', 'unpushed\n', 'unpushed');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'an unpushed commit survives a refresh',
        hasCommit(dest, local) && git(dest, 'rev-parse', 'HEAD') === local,
      );
      check(
        'and the refusal says so beside a ready repository',
        row.status === 'ready' && /1 commit that its remote does not/.test(row.statusMessage ?? ''),
        row,
      );
    }

    // 2. A remote that moved ahead is fast-forwarded to; Haive's work beside it stays.
    {
      const { payload, dest } = await cloned();
      await mkdir(path.join(dest, '.haive', 'worktrees', 'task-x'), { recursive: true });
      await writeFile(path.join(dest, '.haive', 'worktrees', 'task-x', 'wip.txt'), 'wip\n');
      await writeFile(path.join(dest, 'README.md'), 'seed, edited by Haive\n');
      const upstream = await push('upstream.txt', 'from upstream\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'the checkout is fast-forwarded to its remote',
        git(dest, 'rev-parse', 'HEAD') === upstream,
      );
      check(
        'a task worktree and an uncommitted edit stay',
        (await readFile(path.join(dest, '.haive', 'worktrees', 'task-x', 'wip.txt'), 'utf8')) ===
          'wip\n' &&
          (await readFile(path.join(dest, 'README.md'), 'utf8')) === 'seed, edited by Haive\n',
      );
      check(
        'and the repository reads ready with nothing to report',
        row.status === 'ready' && row.statusMessage === null,
        row,
      );

      // 3. Up to date: nothing moves.
      await handleRefresh(payload, db, storage);
      check(
        'a refresh with nothing new changes nothing',
        git(dest, 'rev-parse', 'HEAD') === upstream,
      );
    }

    // 4. An incoming commit touching a file Haive changed: git refuses, the change stays.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await writeFile(path.join(dest, 'README.md'), 'Haive edit\n');
      await push('README.md', 'upstream edit\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a change the incoming commit would overwrite is kept and the head stays',
        (await readFile(path.join(dest, 'README.md'), 'utf8')) === 'Haive edit\n' &&
          git(dest, 'rev-parse', 'HEAD') === before,
      );
      check(
        'and git refusing is reported',
        /git refused the fast-forward/.test(row.statusMessage ?? ''),
        row,
      );
    }

    // 5. A task holding the checkout refuses the refresh.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await push('while-running.txt', 'x\n');
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: payload.repositoryId,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a task using the repository holds the refresh off',
        git(dest, 'rev-parse', 'HEAD') === before &&
          /1 task is using this repository/.test(row.statusMessage ?? ''),
        row,
      );
      await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
    }

    // 5b. A task that starts holding the checkout while the refresh waits for the project-state lock
    // (an upgrade writing its record) keeps the checkout where it was.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await push('during-record.txt', 'x\n');
      let release!: () => void;
      let held!: () => void;
      const locked = new Promise<void>((r) => (held = r));
      const writer = db.transaction(async (tx) => {
        await lockProjectState(tx, payload.repositoryId);
        held();
        await new Promise<void>((r) => (release = r));
      });
      await locked;
      const refreshing = handleRefresh(payload, db, storage);
      await new Promise((r) => setTimeout(r, 500));
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: payload.repositoryId,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      release();
      await writer;
      await refreshing;
      const row = await statusOf(payload.repositoryId);
      check(
        'a task that starts while the refresh waits for the lock holds it off',
        git(dest, 'rev-parse', 'HEAD') === before &&
          /started using this repository/.test(row.statusMessage ?? ''),
        row,
      );
      await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
    }

    // 6. A writable folder import: fetched from the folder, Haive's own changes kept.
    {
      const folder = path.join(tmp, 'folder');
      git(tmp, 'init', '-q', '-b', 'main', folder);
      await commitFile(folder, 'app.txt', 'v1\n', 'v1');
      const [row] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'repo-refresh-smoke',
          source: 'local_path',
          localPath: folder,
          writable: true,
        })
        .returning({ id: schema.repositories.id });
      const payload: RepoJobPayload = {
        repositoryId: row!.id,
        userId,
        source: 'local_path',
        localPath: folder,
      };
      await handleCopyLocal(payload, db, storage);
      const dest = path.join(storage, userId, row!.id);
      await mkdir(path.join(dest, '.haive-data', 'knowledge_base'), { recursive: true });
      await writeFile(path.join(dest, '.haive-data', 'knowledge_base', 'kb.md'), 'kb\n');
      await writeFile(path.join(dest, 'app.txt'), 'v1, edited by Haive\n');
      const folderHead = await commitFile(folder, 'new.txt', 'from the folder\n', 'v2');
      await handleRefresh(payload, db, storage);
      check(
        'a folder import is fast-forwarded from the folder',
        git(dest, 'rev-parse', 'HEAD') === folderHead,
      );
      check(
        "and Haive's knowledge base and edit stay",
        (await readFile(path.join(dest, '.haive-data', 'knowledge_base', 'kb.md'), 'utf8')) ===
          'kb\n' &&
          (await readFile(path.join(dest, 'app.txt'), 'utf8')) === 'v1, edited by Haive\n',
      );
    }

    // 7. A folder that is not a usable checkout is moved aside, then cloned again.
    {
      const { payload, dest } = await cloned();
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest);
      await writeFile(path.join(dest, 'notes.txt'), 'keep me\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      const siblings = await readdir(path.join(storage, userId));
      const aside = siblings.find((n) => n.startsWith(`${payload.repositoryId}.aside-`));
      check(
        'an unusable folder is kept aside and the repository cloned again',
        !!aside &&
          (await readFile(path.join(storage, userId, aside, 'notes.txt'), 'utf8')) ===
            'keep me\n' &&
          git(dest, 'rev-parse', '--verify', 'HEAD').length === 40,
        { siblings },
      );
      check(
        'and the message says where it went',
        row.status === 'ready' && !!aside && (row.statusMessage ?? '').includes(aside),
        row,
      );
    }

    // 8. A detached HEAD is refused.
    {
      const { payload, dest } = await cloned();
      git(dest, 'checkout', '-q', '--detach');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a detached checkout is left as it is',
        /not on a branch/.test(row.statusMessage ?? ''),
        row,
      );
    }

    // 9. A plan base that cannot be taken from the checkout leaves the checkout where it is.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: payload.repositoryId, origin: 'user' },
      );
      await writePlanMirror(db, payload.repositoryId, dest);
      // A row stamped before 0196 holds the hash of the bytes it wrote, and no base.
      await db
        .update(schema.planMirrorState)
        .set({ syncedSnapshot: null })
        .where(eq(schema.planMirrorState.repositoryId, payload.repositoryId));
      await push('after-plan.txt', 'x\n');
      const fn = `refresh_smoke_refuse_${randomBytes(4).toString('hex')}`;
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
            `IF NEW.repository_id = '${payload.repositoryId}' THEN RAISE EXCEPTION 'seed refused'; END IF; ` +
            `RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE UPDATE ON plan_mirror_state ` +
            `FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      try {
        await handleRefresh(payload, db, storage).catch(() => undefined);
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER ${fn} ON plan_mirror_state; DROP FUNCTION ${fn}()`));
      }
      check(
        'a failed plan base seed leaves the checkout unmoved',
        git(dest, 'rev-parse', 'HEAD') === before,
      );
      await handleRefresh(payload, db, storage);
      const seeded = await db.query.planMirrorState.findFirst({
        where: eq(schema.planMirrorState.repositoryId, payload.repositoryId),
      });
      check(
        'and the next refresh seeds the base, then moves it',
        seeded?.syncedSnapshot != null && git(dest, 'rev-parse', 'HEAD') !== before,
        seeded,
      );
    }

    // 10-13. A checkout move sets Haive's own pending projection files aside, then re-renders them
    // over the new head (docs/plans/two-install-project-sync.md, B3.1).
    const RENDER_REL = '.haive-data/state/project/render.json';
    const PLAN_REL = HAIVE_DATA_FILES.plan;
    const column = (over: Record<string, unknown> = {}) => ({
      projectInfo: { name: 'repo-refresh-smoke' },
      framework: null,
      acceptedAgentIds: ['a'],
      customAgentSpecs: [],
      lspLanguages: [],
      rtkChoiceRecorded: true,
      ...over,
    });
    const writeRecord = async (
      dir: string,
      over: Record<string, unknown>,
      settings: Record<string, unknown> = {},
    ) => {
      const files = renderProjectState({
        ...emptyProjectState(),
        render: column(over) as never,
        settings,
      });
      for (const [rel, text] of files) {
        await mkdir(path.dirname(path.join(dir, '.haive-data/state', rel)), { recursive: true });
        await writeFile(path.join(dir, '.haive-data/state', rel), text);
      }
    };
    const upstreamCommit = (message: string, ...paths: string[]) => {
      git(seed, 'add', ...paths);
      git(seed, 'commit', '-q', '-m', message);
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      return git(seed, 'rev-parse', 'HEAD');
    };
    const columnOf = async (id: string) =>
      (
        await db.query.repositories.findFirst({
          where: eq(schema.repositories.id, id),
          columns: { renderContext: true },
        })
      )?.renderContext as {
        acceptedAgentIds?: string[];
        lspLanguages?: string[];
        framework?: string | null;
      } | null;
    /** A cloned repository whose record is committed, then one pending change of Haive's own,
     *  written to render.json by the sweep. */
    const committedRecord = async () => {
      const c = await cloned();
      await db
        .update(schema.repositories)
        .set({ renderContext: column() })
        .where(eq(schema.repositories.id, c.payload.repositoryId));
      await writeProjectStateColumn(db, {
        repositoryId: c.payload.repositoryId,
        repoPath: c.dest,
        column: column(),
      });
      git(c.dest, 'add', '.haive-data/state');
      git(c.dest, 'commit', '-q', '--allow-empty', '-m', 'record');
      git(c.dest, 'push', '-q', 'origin', 'HEAD:main');
      git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
      return c;
    };
    const withPendingRender = async () => {
      const c = await committedRecord();
      await db
        .update(schema.repositories)
        .set({ renderContext: column({ lspLanguages: ['php'] }) })
        .where(eq(schema.repositories.id, c.payload.repositoryId));
      await markProjectStateDirty(db, c.payload.repositoryId);
      await sweepDirtyProjectStates(db);
      return c;
    };
    const taskCtx = async (dest: string, taskId: string): Promise<StepContext> => {
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId,
          stepId: '00a-sync-base',
          stepIndex: 0,
          round: 0,
          title: 'Sync base',
          status: 'running',
        })
        .returning({ id: schema.taskSteps.id });
      return {
        round: 0,
        taskId,
        taskStepId: step!.id,
        userId,
        repoPath: dest,
        workspacePath: dest,
        sandboxWorkdir: '/haive/workdir',
        cliProviderId: null,
        db,
        logger: log.child({ step: '00a-sync-base' }),
        signal: new AbortController().signal,
        throwIfCancelled: () => undefined,
        async emitProgress() {},
      } as StepContext;
    };
    const moveVia = async (via: 'refresh' | '00a', c: Awaited<ReturnType<typeof cloned>>) => {
      if (via === 'refresh') {
        await handleRefresh(c.payload, db, storage);
        return { message: (await statusOf(c.payload.repositoryId)).statusMessage ?? '' };
      }
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: c.payload.repositoryId,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      try {
        const ctx = await taskCtx(c.dest, task!.id);
        const detected = await syncBaseStep.detect!(ctx);
        const out = await syncBaseStep.apply(ctx, {
          detected,
          formValues: { base: 'main' },
          iteration: 0,
          previousIterations: [],
        });
        return { message: out.reason ?? '', strategy: out.strategy };
      } finally {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
      }
    };

    for (const via of ['refresh', '00a'] as const) {
      // 10. Haive's pending change to a state file, an incoming commit touching the same file.
      {
        const c = await withPendingRender();
        const pending = git(c.dest, 'status', '--porcelain', '--', RENDER_REL);
        check(
          `${via}: Haive's pending change leaves render.json modified`,
          pending.startsWith('M') &&
            (await readFile(path.join(c.dest, RENDER_REL), 'utf8')).includes('php'),
          pending,
        );
        await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
        const upstream = upstreamCommit('a teammate adds an agent', '.haive-data/state');
        const moved = await moveVia(via, c);
        const now = JSON.parse(await readFile(path.join(c.dest, RENDER_REL), 'utf8')) as {
          acceptedAgentIds: string[];
          lspLanguages: string[];
        };
        const col = await columnOf(c.payload.repositoryId);
        check(
          `${via}: the checkout moves to the incoming commit past a pending change to a file it touches`,
          git(c.dest, 'rev-parse', 'HEAD') === upstream,
          moved,
        );
        check(
          `${via}: the incoming agent is imported and the pending change survives, in the database and re-rendered over the new head`,
          isDeepEqual(col?.acceptedAgentIds, ['a', 'b']) &&
            isDeepEqual(col?.lspLanguages, ['php']) &&
            isDeepEqual(now.acceptedAgentIds, ['a', 'b']) &&
            isDeepEqual(now.lspLanguages, ['php']),
          { col, now },
        );
      }

      // 11. The same file edited by hand: the move is refused naming it, and nothing moves.
      {
        const c = await withPendingRender();
        const before = git(c.dest, 'rev-parse', 'HEAD');
        await writeFile(path.join(c.dest, RENDER_REL), '{ edited by hand');
        await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
        upstreamCommit('a teammate adds an agent', '.haive-data/state');
        const moved = await moveVia(via, c);
        check(
          `${via}: a hand-edited state file refuses the move and the message names the file`,
          git(c.dest, 'rev-parse', 'HEAD') === before &&
            moved.message.includes(RENDER_REL) &&
            !/git refused|fast-forward failed/.test(moved.message) &&
            (await readFile(path.join(c.dest, RENDER_REL), 'utf8')) === '{ edited by hand',
          moved,
        );
      }
    }

    // 11b. A state file Haive wrote that is not in HEAD yet, which the incoming commit also adds: the
    // untracked copy is set aside, and the two lists are merged rather than one lost.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const SCOPE_REL = '.haive-data/state/settings/scope-exclude-globs.json';
      await db
        .update(schema.repositories)
        .set({ scopeExcludeGlobs: ['a/**'] })
        .where(eq(schema.repositories.id, id));
      await markProjectStateDirty(db, id);
      await sweepDirtyProjectStates(db);
      const untracked = git(c.dest, 'status', '--porcelain', '--', SCOPE_REL);
      await writeRecord(seed, {}, { 'scope-exclude-globs': ['b/**'] });
      const upstream = upstreamCommit('a teammate sets the scope', '.haive-data/state');
      await handleRefresh(c.payload, db, storage);
      const repo = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { scopeExcludeGlobs: true },
      });
      const open = await db.query.projectStateConflicts.findMany({
        where: eq(schema.projectStateConflicts.repositoryId, id),
      });
      check(
        'an untracked state file the incoming commit also adds is set aside and the checkout moves',
        untracked.startsWith('??') && git(c.dest, 'rev-parse', 'HEAD') === upstream,
        untracked,
      );
      check(
        "and the two scope lists are merged, this install's entry kept, with nothing asked",
        isDeepEqual([...(repo?.scopeExcludeGlobs ?? [])].sort(), ['a/**', 'b/**']) &&
          open.every((r) => r.unit !== 'settings/scope-exclude-globs.json'),
        { repo, open: open.map((r) => r.unit) },
      );
    }

    // 11c. A valid hand edit is read in by the sync that runs first, so the database holds it and the
    // set-aside loses nothing.
    {
      const c = await cloned();
      const id = c.payload.repositoryId;
      await db
        .update(schema.repositories)
        .set({ renderContext: column() })
        .where(eq(schema.repositories.id, id));
      await writeProjectStateColumn(db, { repositoryId: id, repoPath: c.dest, column: column() });
      git(c.dest, 'add', '.haive-data/state');
      git(c.dest, 'commit', '-q', '--allow-empty', '-m', 'record');
      git(c.dest, 'push', '-q', 'origin', 'HEAD:main');
      git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
      await writeRecord(c.dest, { lspLanguages: ['go'] });
      const upstream = await push('elsewhere.txt', 'x\n');
      await handleRefresh(c.payload, db, storage);
      const col = await columnOf(id);
      const now = JSON.parse(await readFile(path.join(c.dest, RENDER_REL), 'utf8')) as {
        lspLanguages: string[];
      };
      check(
        'a valid hand edit of a state file is read in, and survives a move that does not touch it',
        git(c.dest, 'rev-parse', 'HEAD') === upstream &&
          isDeepEqual(col?.lspLanguages, ['go']) &&
          isDeepEqual(now.lspLanguages, ['go']),
        { col, now },
      );
    }

    // 11d. HEAD holds no record, Haive has a pending one that is not committed, and the incoming commit
    // adds a record with another value for a key the database holds: the database is the base-less
    // side's only copy, so the incoming value must not be imported over it (an empty base, not a first
    // import).
    for (const via of ['refresh', '00a'] as const) {
      // Its own remote: the shared one already carries a committed record by now.
      const origin2 = path.join(tmp, `origin-no-record-${via}.git`);
      git(tmp, 'init', '-q', '--bare', '-b', 'main', origin2);
      const seed2 = path.join(tmp, `seed-no-record-${via}`);
      git(tmp, 'clone', '-q', `file://${origin2}`, seed2);
      await commitFile(seed2, 'README.md', 'seed\n', 'seed');
      git(seed2, 'push', '-q', 'origin', 'HEAD:main');
      const c = await cloned(origin2);
      const id = c.payload.repositoryId;
      const pendingName = 'pending-name';
      await db
        .update(schema.repositories)
        .set({ renderContext: column({ projectInfo: { name: pendingName } }) })
        .where(eq(schema.repositories.id, id));
      await markProjectStateDirty(db, id);
      await sweepDirtyProjectStates(db);
      const untracked = git(c.dest, 'status', '--porcelain', '--', RENDER_REL);
      await writeRecord(seed2, { projectInfo: { name: 'incoming-name' }, acceptedAgentIds: ['a'] });
      git(seed2, 'add', '.haive-data/state');
      git(seed2, 'commit', '-q', '-m', 'a teammate commits a record');
      git(seed2, 'push', '-q', 'origin', 'HEAD:main');
      const upstream = git(seed2, 'rev-parse', 'HEAD');
      const moved = await moveVia(via, c);
      const col = (await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { renderContext: true },
      }))!.renderContext as { projectInfo?: { name?: string } } | null;
      const now = JSON.parse(await readFile(path.join(c.dest, RENDER_REL), 'utf8')) as {
        projectInfo?: { name?: string };
      };
      const open = await db.query.projectStateConflicts.findMany({
        where: eq(schema.projectStateConflicts.repositoryId, id),
      });
      check(
        `${via}: a pending record with no committed one moves past an incoming record`,
        untracked.startsWith('??') && git(c.dest, 'rev-parse', 'HEAD') === upstream,
        { untracked, moved },
      );
      check(
        `${via}: the database's pending value survives the incoming one, and the clash is asked about rather than silently replaced`,
        col?.projectInfo?.name === pendingName &&
          (now.projectInfo?.name === pendingName ||
            open.some((r) => r.unit === 'project/render.json#projectInfo')),
        { col, now, open: open.map((r) => r.unit) },
      );
    }

    // 11d2. A projection file the repository's .gitignore hides is judged like an untracked one: a
    // hand edit the incoming commit would overwrite refuses the move, and Haive's own copy does not.
    for (const via of ['refresh', '00a'] as const) {
      for (const handEdited of [true, false]) {
        const kind = handEdited ? 'hand-edited' : 'Haive-written';
        const origin3 = path.join(tmp, `origin-ignored-${via}-${handEdited}.git`);
        git(tmp, 'init', '-q', '--bare', '-b', 'main', origin3);
        const seed3 = path.join(tmp, `seed-ignored-${via}-${handEdited}`);
        git(tmp, 'clone', '-q', `file://${origin3}`, seed3);
        await commitFile(seed3, 'README.md', 'seed\n', 'seed');
        await commitFile(seed3, '.gitignore', '.haive-data/\n', 'ignore the data directory');
        git(seed3, 'push', '-q', 'origin', 'HEAD:main');
        const c = await cloned(origin3);
        const id = c.payload.repositoryId;
        await db
          .update(schema.repositories)
          .set({ renderContext: column() })
          .where(eq(schema.repositories.id, id));
        await markProjectStateDirty(db, id);
        await sweepDirtyProjectStates(db);
        const handBytes = '{ edited by hand';
        if (handEdited) await writeFile(path.join(c.dest, RENDER_REL), handBytes);
        const ignored = git(c.dest, 'status', '--porcelain', '--ignored', '--', RENDER_REL);
        const before = git(c.dest, 'rev-parse', 'HEAD');
        await writeRecord(seed3, { acceptedAgentIds: ['a'] });
        git(seed3, 'add', '-f', '.haive-data/state');
        git(seed3, 'commit', '-q', '-m', 'a teammate commits a record');
        git(seed3, 'push', '-q', 'origin', 'HEAD:main');
        const upstream = git(seed3, 'rev-parse', 'HEAD');
        const moved = await moveVia(via, c);
        const now = await readFile(path.join(c.dest, RENDER_REL), 'utf8');
        if (handEdited) {
          check(
            `I1: ${via}: an ignored ${kind} state file the incoming commit adds refuses the move, is named, and keeps its bytes`,
            ignored.startsWith('!!') &&
              git(c.dest, 'rev-parse', 'HEAD') === before &&
              moved.message.includes(RENDER_REL) &&
              now === handBytes,
            { ignored, moved, now },
          );
        } else {
          check(
            `I2: ${via}: an ignored ${kind} state file the incoming commit adds does not refuse the move`,
            ignored.startsWith('!!') && git(c.dest, 'rev-parse', 'HEAD') === upstream,
            { ignored, moved },
          );
        }
      }
    }

    // 11e. A task that becomes checkout-holding after the first check and before the set-aside leaves
    // Haive's projection files exactly as they were, and the refresh answers with the task count.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const before = await readFile(path.join(c.dest, RENDER_REL));
      const headBefore = git(c.dest, 'rev-parse', 'HEAD');
      const startTask = async () => {
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'onboarding',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      const stopTasks = () => db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      const aside = await setAsideHaiveProjections(db, id, c.dest, async (conn) => {
        await startTask();
        return checkoutHoldingTasks(conn, id);
      });
      const after = await readFile(path.join(c.dest, RENDER_REL));
      check(
        'a task that starts before the set-aside holds it back, and the state file keeps its bytes',
        aside.outcome === 'held' && before.equals(after),
        { aside, changed: !before.equals(after) },
      );
      await stopTasks();

      // The same through a refresh: the task appears while the plan base is seeded, after the first check.
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      await db
        .update(schema.planMirrorState)
        .set({ syncedSnapshot: null })
        .where(eq(schema.planMirrorState.repositoryId, id));
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const planBefore = await readFile(path.join(c.dest, PLAN_REL));
      const renderBefore = await readFile(path.join(c.dest, RENDER_REL));
      const fn = `refresh_smoke_task_${randomBytes(4).toString('hex')}`;
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
            `IF NEW.repository_id = '${id}' THEN INSERT INTO tasks (user_id, repository_id, type, title, status) ` +
            `VALUES ('${userId}', '${id}', 'onboarding', 'repo-refresh-smoke', 'running'); END IF; ` +
            `RETURN NEW; END $$; CREATE TRIGGER ${fn} AFTER UPDATE ON plan_mirror_state ` +
            `FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      try {
        await handleRefresh(c.payload, db, storage);
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER ${fn} ON plan_mirror_state; DROP FUNCTION ${fn}()`));
        await stopTasks();
      }
      const message = (await statusOf(id)).statusMessage ?? '';
      check(
        'a refresh whose task starts after its first check refuses with the task count and moves nothing',
        /1 task is using this repository/.test(message) &&
          git(c.dest, 'rev-parse', 'HEAD') === headBefore &&
          (await readFile(path.join(c.dest, RENDER_REL))).equals(renderBefore) &&
          (await readFile(path.join(c.dest, PLAN_REL))).equals(planBefore),
        { message },
      );
    }

    // 11e2. A task that starts after the state files were set aside and before the plan's were: the held
    // result puts the state files back, so the task finds Haive's projections as they were.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const target = path.join(c.dest, RENDER_REL);
      const before = await readFile(target);
      const headRender = execFileSync('git', ['show', `HEAD:${RENDER_REL}`], {
        cwd: c.dest,
        env: gitEnv,
      });
      let started = false;
      const aside = await setAsideHaiveProjections(db, id, c.dest, async (conn) => {
        if (!started && (await readFile(target)).equals(headRender)) {
          started = true;
          await db.insert(schema.tasks).values({
            userId,
            repositoryId: id,
            type: 'workflow',
            title: 'repo-refresh-smoke',
            status: 'running',
          });
        }
        return checkoutHoldingTasks(conn, id);
      });
      const after = await readFile(target);
      await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      check(
        'a task that starts between the state and the plan set-aside gets the state files put back',
        aside.outcome === 'held' && started && after.equals(before),
        { aside, started, atHead: after.equals(headRender) },
      );
    }

    // 11e3. A refresh whose move check asked for a retry, and whose next set-aside is then held, puts back
    // what the first set-aside restored: the state file is Haive's again, not HEAD's.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const renderBefore = await readFile(path.join(c.dest, RENDER_REL));
      const planBytes = await readFile(path.join(c.dest, PLAN_REL));
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores !== 2) return;
        await writeFile(path.join(c.dest, PLAN_REL), planBytes);
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      try {
        await handleRefresh(c.payload, db, storage);
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const message = (await statusOf(id)).statusMessage ?? '';
      const renderAfter = await readFile(path.join(c.dest, RENDER_REL));
      check(
        'a refresh held after a retried move puts back the state files its first set-aside restored',
        restores >= 2 &&
          /1 task is using this repository/.test(message) &&
          renderAfter.equals(renderBefore),
        { restores, message, back: renderAfter.equals(renderBefore) },
      );
    }

    // 11e5. The no-move exits with an onboarding holder, which defers a re-sync: the kept bytes go back.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const target = path.join(c.dest, RENDER_REL);
      const before = await readFile(target);
      const headRender = execFileSync('git', ['show', `HEAD:${RENDER_REL}`], {
        cwd: c.dest,
        env: gitEnv,
      });
      let started = false;
      const aside = await setAsideHaiveProjections(db, id, c.dest, async (conn) => {
        if (!started && (await readFile(target)).equals(headRender)) {
          started = true;
          await db.insert(schema.tasks).values({
            userId,
            repositoryId: id,
            type: 'onboarding',
            title: 'repo-refresh-smoke',
            status: 'running',
          });
        }
        return checkoutHoldingTasks(conn, id);
      });
      const after = await readFile(target);
      await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      check(
        'O1: an onboarding task that starts between the state and the plan set-aside gets the state files put back',
        aside.outcome === 'held' && started && after.equals(before),
        { aside, started, atHead: after.equals(headRender) },
      );
    }
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const renderBefore = await readFile(path.join(c.dest, RENDER_REL));
      const planBytes = await readFile(path.join(c.dest, PLAN_REL));
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores !== 2) return;
        await writeFile(path.join(c.dest, PLAN_REL), planBytes);
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'onboarding',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      try {
        await handleRefresh(c.payload, db, storage);
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const message = (await statusOf(id)).statusMessage ?? '';
      const renderAfter = await readFile(path.join(c.dest, RENDER_REL));
      check(
        'O2: a refresh held by an onboarding task after a retried move puts back the state files',
        restores >= 2 &&
          /1 task is using this repository/.test(message) &&
          renderAfter.equals(renderBefore),
        { restores, message, back: renderAfter.equals(renderBefore) },
      );
    }
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const renderBefore = await readFile(path.join(c.dest, RENDER_REL));
      const headBefore = git(c.dest, 'rev-parse', 'HEAD');
      const [own] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: id,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      let sibling = false;
      restoreFaults.afterRestore = async () => {
        if (sibling) return;
        sibling = true;
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'onboarding',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      let out;
      try {
        const ctx = await taskCtx(c.dest, own!.id);
        const detected = await syncBaseStep.detect!(ctx);
        out = await syncBaseStep.apply(ctx, {
          detected,
          formValues: { base: 'main' },
          iteration: 0,
          previousIterations: [],
        });
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const renderAfter = await readFile(path.join(c.dest, RENDER_REL));
      check(
        'O3: 00a skips the base when an onboarding task appears after the set-aside, and the state files are put back',
        sibling &&
          out?.strategy === 'skipped' &&
          git(c.dest, 'rev-parse', 'HEAD') === headBefore &&
          renderAfter.equals(renderBefore),
        { sibling, out, back: renderAfter.equals(renderBefore) },
      );
    }

    // E1/E2. A Stop or a cancel that lands during 00a's set-aside fences what follows: E1 a Stop (the task
    // failed at the pass's epoch) refuses the move and the files go back; E2 a cancel before the restore
    // refuses the restore itself, which runs in the claim's section.
    {
      const stopped = async (
        at: 'beforeCapture' | 'afterBase',
        status: 'failed' | 'cancelled',
      ): Promise<{ thrown: unknown; restored: boolean; moved: boolean; back: boolean }> => {
        const c = await withPendingRender();
        const id = c.payload.repositoryId;
        await writeRecord(seed, { acceptedAgentIds: ['a', 'b', at] });
        upstreamCommit(`a teammate adds agent ${at}`, '.haive-data/state');
        const renderBefore = await readFile(path.join(c.dest, RENDER_REL));
        const headBefore = git(c.dest, 'rev-parse', 'HEAD');
        const [own] = await db
          .insert(schema.tasks)
          .values({
            userId,
            repositoryId: id,
            type: 'workflow',
            title: 'repo-refresh-smoke',
            status: 'running',
          })
          .returning({ id: schema.tasks.id, epoch: schema.tasks.orchestrationEpoch });
        let restored = false;
        restoreFaults[at] = async () => {
          await db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, own!.id));
        };
        restoreFaults.beforeRestore = () => {
          restored = true;
        };
        let thrown: unknown = null;
        try {
          const ctx = { ...(await taskCtx(c.dest, own!.id)), epoch: own!.epoch };
          const detected = await syncBaseStep.detect!(ctx);
          await syncBaseStep.apply(ctx, {
            detected,
            formValues: { base: 'main' },
            iteration: 0,
            previousIterations: [],
          });
        } catch (err) {
          thrown = err;
        } finally {
          delete restoreFaults[at];
          delete restoreFaults.beforeRestore;
          await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
        }
        return {
          thrown,
          restored,
          moved: git(c.dest, 'rev-parse', 'HEAD') !== headBefore,
          back: (await readFile(path.join(c.dest, RENDER_REL))).equals(renderBefore),
        };
      };
      const e1 = await stopped('beforeCapture', 'failed');
      check(
        'E1: a Stop during the set-aside refuses the move at the pass epoch, and the files go back',
        e1.thrown instanceof StepSupersededError && e1.restored && !e1.moved && e1.back,
        { ...e1, thrown: String(e1.thrown) },
      );
      const e2 = await stopped('afterBase', 'cancelled');
      check(
        'E2: a cancel before the restore refuses the restore in the claim section, leaving the files as they were',
        e2.thrown instanceof StepSupersededError && !e2.restored && !e2.moved && e2.back,
        { ...e2, thrown: String(e2.thrown) },
      );

      // E3. A cancel releases the claim and another task takes the checkout before the put-back: the put-back
      // is refused, so Haive's files are not rewritten under that task's merge. The claim rows are swapped
      // in beforePutBack, since the restore's section still holds the own claim row when afterRestore runs.
      const c3 = await withPendingRender();
      const id3 = c3.payload.repositoryId;
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'e3'] });
      upstreamCommit('a teammate adds agent e3', '.haive-data/state');
      const renderBefore3 = await readFile(path.join(c3.dest, RENDER_REL));
      const headBefore3 = git(c3.dest, 'rev-parse', 'HEAD');
      const [own3] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: id3,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id, epoch: schema.tasks.orchestrationEpoch });
      restoreFaults.afterRestore = async () => {
        delete restoreFaults.afterRestore;
        await db
          .update(schema.tasks)
          .set({ status: 'cancelled' })
          .where(eq(schema.tasks.id, own3!.id));
      };
      restoreFaults.beforePutBack = async () => {
        delete restoreFaults.beforePutBack;
        await db.delete(schema.mergeDirClaims).where(eq(schema.mergeDirClaims.mergeDir, c3.dest));
        const [other] = await db
          .insert(schema.tasks)
          .values({
            userId,
            repositoryId: id3,
            type: 'workflow',
            title: 'repo-refresh-smoke-other',
            status: 'running',
          })
          .returning({ id: schema.tasks.id });
        const [otherStep] = await db
          .insert(schema.taskSteps)
          .values({
            taskId: other!.id,
            stepId: '12-worktree-cleanup',
            stepIndex: 0,
            title: 'merge',
            status: 'running',
          })
          .returning({ id: schema.taskSteps.id });
        await db.insert(schema.mergeDirClaims).values({
          mergeDir: c3.dest,
          taskId: other!.id,
          taskStepId: otherStep!.id,
        });
      };
      let thrown3: unknown = null;
      try {
        const ctx = { ...(await taskCtx(c3.dest, own3!.id)), epoch: own3!.epoch };
        const detected = await syncBaseStep.detect!(ctx);
        await syncBaseStep.apply(ctx, {
          detected,
          formValues: { base: 'main' },
          iteration: 0,
          previousIterations: [],
        });
      } catch (err) {
        thrown3 = err;
      } finally {
        delete restoreFaults.afterRestore;
        delete restoreFaults.beforePutBack;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id3));
      }
      const renderAfter3 = await readFile(path.join(c3.dest, RENDER_REL));
      check(
        'E3: a put-back refused while another task holds the checkout writes nothing and names the files',
        thrown3 !== null &&
          !renderAfter3.equals(renderBefore3) &&
          git(c3.dest, 'rev-parse', 'HEAD') === headBefore3 &&
          String(thrown3).includes(RENDER_REL),
        { thrown: String(thrown3), back: renderAfter3.equals(renderBefore3) },
      );
    }

    // 11e6. A person who edits a restored file before the put-back keeps their bytes: the put-back swaps
    // a file only while it still holds what the restore left.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const target = path.join(c.dest, RENDER_REL);
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores !== 1) return;
        await writeFile(target, '{"edited":"by a person"}\n');
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'onboarding',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      let aside;
      try {
        aside = await setAsideHaiveProjections(db, id, c.dest, (conn) =>
          checkoutHoldingTasks(conn, id),
        );
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const now = await readFile(target, 'utf8');
      check(
        "a person's edit made before the put-back survives it",
        aside.outcome === 'held' && now === '{"edited":"by a person"}\n',
        { aside, now },
      );
    }

    // 11e7. A refresh that set projections aside and then could not move puts a staged plan.md back in
    // the index as it was, not only its working copy.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const mdRel = HAIVE_DATA_FILES.planMarkdown;
      await writeFile(path.join(c.dest, mdRel), '# staged by a person\n');
      git(c.dest, 'add', '--', mdRel);
      await writeFile(path.join(c.dest, mdRel), '# working copy, not staged\n');
      const stagedBefore = git(c.dest, 'ls-files', '-s', '--', mdRel);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'c'] });
      upstreamCommit('a teammate adds another agent', '.haive-data/state');
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores !== 2) return;
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
      };
      try {
        await handleRefresh(c.payload, db, storage);
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const stagedAfter = git(c.dest, 'ls-files', '-s', '--', mdRel);
      const workingAfter = await readFile(path.join(c.dest, mdRel), 'utf8');
      check(
        'a refresh that could not move puts a staged plan.md back in the index and its working copy back',
        restores >= 2 &&
          stagedBefore !== '' &&
          stagedAfter === stagedBefore &&
          workingAfter === '# working copy, not staged\n',
        { restores, stagedBefore, stagedAfter, workingAfter },
      );
    }

    // 11e8. A file written by someone else after the set-aside captured it and before its restore is not
    // overwritten: the restore swaps only what it captured, so the set-aside goes round, re-judges and refuses.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const target = path.join(c.dest, RENDER_REL);
      const foreign = '{"written":"in a terminal"}\n';
      let fired = false;
      restoreFaults.beforeRestore = async () => {
        if (fired) return;
        fired = true;
        await writeFile(target, foreign);
      };
      let aside;
      try {
        aside = await setAsideHaiveProjections(db, id, c.dest);
      } finally {
        delete restoreFaults.beforeRestore;
      }
      const now = await readFile(target, 'utf8');
      check(
        'a write landing between the capture and the restore is kept, and the set-aside refuses it',
        fired && aside.outcome === 'refused' && now === foreign,
        { aside, now },
      );
    }

    // 11e9. A refresh retried after its move check keeps the first snapshot of each path: a render.json
    // staged with Haive's bytes is staged again after the retried refresh is held.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const target = path.join(c.dest, RENDER_REL);
      const rendered = await readFile(target);
      git(c.dest, 'add', '--', RENDER_REL);
      const stagedBefore = git(c.dest, 'ls-files', '-s', '--', RENDER_REL);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'c', 'd'] });
      upstreamCommit('a teammate adds a fourth agent', '.haive-data/state');
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores === 2) await writeFile(target, rendered);
        if (restores === 3) {
          await db.insert(schema.tasks).values({
            userId,
            repositoryId: id,
            type: 'workflow',
            title: 'repo-refresh-smoke',
            status: 'running',
          });
        }
      };
      try {
        await handleRefresh(c.payload, db, storage);
      } finally {
        delete restoreFaults.afterRestore;
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const stagedAfter = git(c.dest, 'ls-files', '-s', '--', RENDER_REL);
      check(
        'a retried, then held refresh stages render.json again as the first set-aside found it',
        restores >= 3 && stagedAfter === stagedBefore,
        { restores, stagedBefore, stagedAfter },
      );
    }

    // 11e10. A projection that cannot be captured for its restore (here a link put in its place after the
    // re-judge) is not restored over: the set-aside goes round, the offenders refuse it, and the link stays.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const target = path.join(c.dest, RENDER_REL);
      let fired = false;
      restoreFaults.beforeCapture = async () => {
        if (fired) return;
        fired = true;
        await rm(target);
        await symlink('elsewhere.json', target);
      };
      let aside;
      try {
        aside = await setAsideHaiveProjections(db, id, c.dest);
      } finally {
        delete restoreFaults.beforeCapture;
      }
      const stillLink = (await lstat(target).catch(() => null))?.isSymbolicLink() ?? false;
      check(
        'a projection swapped for a link before its capture is refused, not restored over',
        fired && aside.outcome === 'refused' && stillLink,
        { aside, stillLink },
      );
    }

    // 11e11. A put-back that cannot finish (git's index is locked) fails the refresh instead of reporting
    // an unmoved checkout over files and staged entries still at HEAD.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const mdRel = HAIVE_DATA_FILES.planMarkdown;
      await writeFile(path.join(c.dest, mdRel), '# staged by a person\n');
      git(c.dest, 'add', '--', mdRel);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'c', 'd', 'e'] });
      upstreamCommit('a teammate adds a fifth agent', '.haive-data/state');
      const lock = path.join(c.dest, '.git', 'index.lock');
      let restores = 0;
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores !== 2) return;
        await db.insert(schema.tasks).values({
          userId,
          repositoryId: id,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        });
        await writeFile(lock, '');
      };
      let failed = '';
      try {
        await handleRefresh(c.payload, db, storage);
      } catch (err) {
        failed = (err as Error).message;
      } finally {
        delete restoreFaults.afterRestore;
        await rm(lock, { force: true });
        await db.delete(schema.tasks).where(eq(schema.tasks.repositoryId, id));
      }
      const status = (await statusOf(id)).statusMessage ?? '';
      check(
        'a put-back that cannot finish fails the refresh visibly',
        restores >= 2 &&
          (/update-index|index\.lock/.test(failed) || /index\.lock|update-index/.test(status)),
        { restores, failed, status },
      );
    }

    // 11e12. A regular write landing just before the capture is not adopted as Haive's snapshot: the
    // judged state is checked again after the capture, so the set-aside refuses and the write survives.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const target = path.join(c.dest, RENDER_REL);
      const foreign = '{"written":"just before the capture"}\n';
      let fired = false;
      restoreFaults.beforeCapture = async () => {
        if (fired) return;
        fired = true;
        await writeFile(target, foreign);
      };
      let aside;
      try {
        aside = await setAsideHaiveProjections(db, id, c.dest);
      } finally {
        delete restoreFaults.beforeCapture;
      }
      const now = await readFile(target, 'utf8');
      check(
        'a write landing just before the capture is refused, not adopted and overwritten',
        fired && aside.outcome === 'refused' && now === foreign,
        { aside, now },
      );
    }

    // 11e13. A refresh whose retried set-aside throws puts back the first pass's snapshot, so a
    // render.json staged with Haive's bytes is staged again.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const target = path.join(c.dest, RENDER_REL);
      const rendered = await readFile(target);
      git(c.dest, 'add', '--', RENDER_REL);
      const stagedBefore = git(c.dest, 'ls-files', '-s', '--', RENDER_REL);
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
      upstreamCommit('a teammate adds a sixth agent', '.haive-data/state');
      let restores = 0;
      let captures = 0;
      const boom = new Error('the retried set-aside fails');
      restoreFaults.afterRestore = async () => {
        restores += 1;
        if (restores === 2) await writeFile(target, rendered);
      };
      restoreFaults.beforeCapture = () => {
        captures += 1;
        if (captures === 3) throw boom;
      };
      let thrown: unknown = null;
      try {
        await handleRefresh(c.payload, db, storage);
      } catch (err) {
        thrown = err;
      } finally {
        delete restoreFaults.afterRestore;
        delete restoreFaults.beforeCapture;
      }
      const stagedAfter = git(c.dest, 'ls-files', '-s', '--', RENDER_REL);
      check(
        'a refresh whose retried set-aside throws stages render.json again as the first pass found it',
        stagedAfter === stagedBefore,
        { thrown: String(thrown), restores, captures, stagedBefore, stagedAfter },
      );
    }

    // 11e14. A re-sync while a merge is open reads nothing in: the record in the checkout may be one
    // the person is about to abort.
    {
      const c = await committedRecord();
      const id = c.payload.repositoryId;
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
      upstreamCommit('a teammate adds a seventh agent', '.haive-data/state');
      git(c.dest, 'pull', '-q', '--ff-only', 'origin', 'main');
      const baseOf = async () =>
        JSON.stringify(
          (
            await db.query.projectStateSync.findFirst({
              where: eq(schema.projectStateSync.repositoryId, id),
            })
          )?.baseSnapshot ?? null,
        );
      const before = await baseOf();
      const mergeHead = path.join(c.dest, '.git', 'MERGE_HEAD');
      await writeFile(mergeHead, `${git(c.dest, 'rev-parse', 'HEAD')}\n`);
      try {
        await resyncHaiveProjections(db, id, c.dest);
      } finally {
        await rm(mergeHead, { force: true });
      }
      const after = await baseOf();
      check('a re-sync while a merge is open reads nothing in', after === before, {
        changed: after !== before,
      });
    }

    // 11e15. A mode change landing between the capture and the restore of an untracked projection keeps
    // the file: the parked removal judges its mode as well as its bytes.
    {
      const c = await cloned();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const planPath = path.join(c.dest, PLAN_REL);
      let fired = false;
      restoreFaults.beforeRestore = async () => {
        if (fired) return;
        fired = true;
        await chmod(planPath, 0o755);
      };
      let aside;
      try {
        aside = await setAsideHaiveProjections(db, id, c.dest);
      } finally {
        delete restoreFaults.beforeRestore;
      }
      const mode = ((await stat(planPath).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'a mode change landing before the restore keeps the untracked plan.json and refuses',
        fired && aside.outcome === 'refused' && mode === 0o755,
        { aside, mode: mode.toString(8) },
      );
    }

    // 11e4. A re-sync that fails after a clean move raises the domain's mark, so the sweep retries it.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      await sweepDirtyProjectStates(db);
      const markOf = async () => {
        const [row] = await db
          .select({
            revision: schema.projectStateOutbox.revision,
            written: schema.projectStateOutbox.writtenRevision,
          })
          .from(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, id))
          .limit(1);
        return row ?? null;
      };
      const clean = await markOf();
      restoreFaults.beforeResync = (domain) => {
        if (domain === 'state') throw new Error('transient sync failure');
      };
      try {
        await resyncHaiveProjections(db, id, c.dest);
      } finally {
        delete restoreFaults.beforeResync;
      }
      const after = await markOf();
      check(
        'a failed re-sync after a clean move leaves the project-state mark raised',
        clean !== null &&
          clean.written === clean.revision &&
          after !== null &&
          after.written < after.revision,
        { clean, after },
      );
    }

    // 11f. A conflict is pending on a render key: the writer renders the incoming side into the file and
    // the base side into the sync base, and the file it wrote is still Haive's, so the move is not refused.
    for (const via of ['refresh', '00a'] as const) {
      const c = await committedRecord();
      const id = c.payload.repositoryId;
      await db
        .update(schema.repositories)
        .set({ renderContext: column({ framework: 'laravel' }) })
        .where(eq(schema.repositories.id, id));
      await writeRecord(c.dest, { framework: 'symfony' });
      await markProjectStateDirty(db, id);
      await sweepDirtyProjectStates(db);
      const written = JSON.parse(await readFile(path.join(c.dest, RENDER_REL), 'utf8')) as {
        framework: string;
      };
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'], framework: 'symfony' });
      const upstream = upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const moved = await moveVia(via, c);
      const row = await db.query.projectStateConflicts.findFirst({
        where: eq(schema.projectStateConflicts.repositoryId, id),
      });
      const col = await columnOf(id);
      check(
        `${via}: a pending conflict leaves the file the writer rendered Haive's own, and the checkout moves`,
        written.framework === 'symfony' && git(c.dest, 'rev-parse', 'HEAD') === upstream,
        { written, moved },
      );
      check(
        `${via}: and the conflict is still pending, with this install's value kept`,
        row?.unit === 'project/render.json#framework' &&
          row.resolvedAt === null &&
          col?.framework === 'laravel',
        { row, col },
      );
    }

    // 11g. A writer that rewrites a file after the set-aside has restored it and before the move cannot get
    // the move refused. The writer takes the project-state lock as the real one does, and holds it a
    // second while it writes the file and the sync base it was written from: a rebase that read the
    // working tree outside the set-aside's lock would record HEAD as the base after the writer's. Each
    // commit that writes the mark or the base sleeps, so the writer queues for the lock before it is released.
    for (const via of ['refresh', '00a'] as const) {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const target = path.join(c.dest, RENDER_REL);
      const rendered = await readFile(target);
      const headBytes = execFileSync('git', ['show', `HEAD:${RENDER_REL}`], {
        cwd: c.dest,
        env: gitEnv,
      });
      const [synced] = await db
        .select({ baseSnapshot: schema.projectStateSync.baseSnapshot })
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, id));
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      const upstream = upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const fn = `refresh_smoke_race_${randomBytes(4).toString('hex')}`;
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
            `IF NEW.repository_id = '${id}' THEN PERFORM pg_sleep(0.5); END IF; RETURN NULL; END $$; ` +
            `CREATE CONSTRAINT TRIGGER ${fn}_o AFTER INSERT OR UPDATE ON project_state_outbox ` +
            `DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}(); ` +
            `CREATE CONSTRAINT TRIGGER ${fn}_s AFTER INSERT OR UPDATE ON project_state_sync ` +
            `DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      let rewrote = false;
      let started = false;
      const poll = setInterval(() => {
        if (started) return;
        void readFile(target)
          .then(async (now) => {
            if (started || !now.equals(headBytes)) return;
            started = true;
            await db.transaction(async (tx) => {
              await lockProjectState(tx, id);
              await new Promise((r) => setTimeout(r, 1000));
              await writeFile(target, rendered);
              await tx
                .update(schema.projectStateSync)
                .set({ baseSnapshot: synced!.baseSnapshot })
                .where(eq(schema.projectStateSync.repositoryId, id));
            });
            rewrote = true;
          })
          .catch(() => undefined);
      }, 20);
      let moved;
      try {
        moved = await moveVia(via, c);
        while (started && !rewrote) await new Promise((r) => setTimeout(r, 50));
      } finally {
        clearInterval(poll);
        await db.execute(
          sql.raw(
            `DROP TRIGGER ${fn}_o ON project_state_outbox; DROP TRIGGER ${fn}_s ON project_state_sync; DROP FUNCTION ${fn}()`,
          ),
        );
      }
      check(
        `${via}: a file rewritten between the set-aside and the move does not stop the move`,
        rewrote && git(c.dest, 'rev-parse', 'HEAD') === upstream,
        { rewrote, moved },
      );
    }

    // 11h. The check before the move holds the locks the sweeps take: a sweep started while it is open
    // writes nothing until it ends.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const headRender = git(c.dest, 'show', `HEAD:${RENDER_REL}`);
      const aside = await setAsideHaiveProjections(db, id, c.dest);
      await db
        .update(schema.repositories)
        .set({ renderContext: column({ lspLanguages: ['ruby'] }) })
        .where(eq(schema.repositories.id, id));
      await markProjectStateDirty(db, id);
      let sweep: Promise<number> | null = null;
      let during = '';
      await db.transaction(async (tx) => {
        const checked = await restoreProjectionsInTx(tx, id, c.dest);
        sweep = sweepDirtyProjectStates(db);
        await new Promise((r) => setTimeout(r, 1500));
        during = await readFile(path.join(c.dest, RENDER_REL), 'utf8');
        check(
          'the check finds the files at HEAD after the set-aside',
          aside.outcome === 'set-aside' && checked.outcome === 'clean',
          { aside, checked },
        );
      });
      await sweep;
      await sweepDirtyProjectStates(db);
      const after = await readFile(path.join(c.dest, RENDER_REL), 'utf8');
      check(
        'a sweep started while the check is open waits for it, then writes',
        during.trim() === headRender.trim() && after.includes('ruby'),
        { during, after },
      );
    }

    // 11i. A fast-forward that landed while the process died leaves a checkout at origin's head with the
    // record not read in: the next run finds nothing to move, and still brings the record in.
    for (const via of ['refresh', '00a'] as const) {
      const c = await committedRecord();
      const id = c.payload.repositoryId;
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      const upstream = upstreamCommit('a teammate adds an agent', '.haive-data/state');
      git(c.dest, 'fetch', '-q', 'origin', 'main');
      git(c.dest, 'merge', '-q', '--ff-only', 'origin/main');
      const before = await columnOf(id);
      const moved = await moveVia(via, c);
      const col = await columnOf(id);
      check(
        `${via}: a checkout already at origin's head still imports the record it holds`,
        git(c.dest, 'rev-parse', 'HEAD') === upstream &&
          isDeepEqual(before?.acceptedAgentIds, ['a']) &&
          isDeepEqual(col?.acceptedAgentIds, ['a', 'b']),
        { before, col, moved },
      );
    }

    // 11j. The mark that says the files are stale is committed before the files move: a set-aside whose
    // second transaction fails after the restore leaves the files at HEAD and the row dirty, so the sweep
    // is not skipped.
    {
      const c = await withPendingRender();
      const id = c.payload.repositoryId;
      const rowOf = () =>
        db
          .select({
            revision: schema.projectStateOutbox.revision,
            written: schema.projectStateOutbox.writtenRevision,
          })
          .from(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, id))
          .then((rows) => rows[0]!);
      const clean = await rowOf();
      const beforeAside = await readFile(path.join(c.dest, RENDER_REL), 'utf8');
      const failure = new Error('crash after the restore');
      let restored = null;
      restoreFaults.afterRestore = () => {
        throw failure;
      };
      try {
        restored = await setAsideHaiveProjections(db, id, c.dest);
      } catch (err) {
        if (err !== failure) throw err;
      } finally {
        delete restoreFaults.afterRestore;
      }
      const dirty = await rowOf();
      check(
        'the stale mark survives a set-aside that fails after the restore, and the files are put back',
        clean.written === clean.revision &&
          dirty.written < dirty.revision &&
          (await readFile(path.join(c.dest, RENDER_REL), 'utf8')) === beforeAside,
        { restored, clean, dirty },
      );
    }

    // 11k. A crash at any point of the restore never loses the pending value: the sync base is committed at
    // HEAD's record before the files move, so a sweep that finds the files at HEAD or still pending merges
    // them against a base that agrees with them.
    {
      const crash = new Error('crash inside the restore');
      const crashing = async (
        point: 'afterBase' | 'afterRestore' | null,
        run: (c: Awaited<ReturnType<typeof withPendingRender>>) => Promise<unknown>,
      ) => {
        const c = await withPendingRender();
        if (point) {
          restoreFaults[point] = () => {
            throw crash;
          };
        }
        let thrown: unknown = null;
        try {
          await run(c);
        } catch (err) {
          thrown = err;
        } finally {
          if (point) delete restoreFaults[point];
        }
        const onDisk = () => readFile(path.join(c.dest, RENDER_REL), 'utf8');
        const crashed = await onDisk();
        await sweepDirtyProjectStates(db);
        return {
          c,
          thrown,
          crashed,
          col: await columnOf(c.payload.repositoryId),
          disk: await onDisk(),
        };
      };
      const survived = (r: Awaited<ReturnType<typeof crashing>>) =>
        r.thrown === crash &&
        isDeepEqual(r.col?.lspLanguages, ['php']) &&
        JSON.parse(r.disk).lspLanguages?.includes('php') === true;

      const k1 = await crashing('afterRestore', (c) =>
        setAsideHaiveProjections(db, c.payload.repositoryId, c.dest),
      );
      check(
        'K1: a failure after the set-aside restored the files puts them back and keeps the pending value',
        survived(k1) && k1.crashed.includes('php'),
        { thrown: String(k1.thrown), crashed: k1.crashed, col: k1.col, disk: k1.disk },
      );

      const putErr = new Error('put-back refused');
      restoreFaults.beforePutBack = () => {
        throw putErr;
      };
      const k1b = await crashing('afterRestore', (c) =>
        setAsideHaiveProjections(db, c.payload.repositoryId, c.dest),
      ).finally(() => delete restoreFaults.beforePutBack);
      const k1bErrs = k1b.thrown instanceof AggregateError ? k1b.thrown.errors : [];
      check(
        'K1b: a put-back that fails after a failure is thrown with it, naming the files, never dropped',
        k1bErrs[0] === crash &&
          k1bErrs[1] === putErr &&
          String((k1b.thrown as Error).message).includes(RENDER_REL),
        { thrown: String(k1b.thrown) },
      );

      let inTx = '';
      const k2 = await crashing(null, (c) =>
        db.transaction(async (tx) => {
          inTx = (await restoreProjectionsInTx(tx, c.payload.repositoryId, c.dest)).outcome;
          throw crash;
        }),
      );
      check(
        'K2: a crash inside the move transaction finds nothing written, and keeps the pending value',
        survived(k2) && k2.crashed.includes('php') && inTx === 'retry',
        { thrown: String(k2.thrown), inTx, crashed: k2.crashed, col: k2.col, disk: k2.disk },
      );

      const k3 = await crashing('afterBase', (c) =>
        setAsideHaiveProjections(db, c.payload.repositoryId, c.dest),
      );
      await writeRecord(seed, { acceptedAgentIds: ['a', 'b'] });
      const upstream = upstreamCommit('a teammate adds an agent', '.haive-data/state');
      const moved = await moveVia('refresh', k3.c);
      const after = await columnOf(k3.c.payload.repositoryId);
      check(
        'K3: a crash after the base commit and before the restore keeps the pending value, and the next set-aside and move succeed',
        survived(k3) &&
          k3.crashed.includes('php') &&
          git(k3.c.dest, 'rev-parse', 'HEAD') === upstream &&
          isDeepEqual(after?.lspLanguages, ['php']) &&
          isDeepEqual(after?.acceptedAgentIds, ['a', 'b']),
        { thrown: String(k3.thrown), col: k3.col, disk: k3.disk, moved, after },
      );
    }

    // 11l. A foreign edit staged in the index is not Haive's to discard, even when the working tree has
    // Haive's bytes back: the set-aside refuses, names the file, and leaves the index blob alone.
    {
      const indexed = (dir: string, rel: string) => {
        try {
          return git(dir, 'rev-parse', `:${rel}`);
        } catch {
          return 'absent';
        }
      };
      const stageForeign = async (dir: string, rel: string) => {
        const target = path.join(dir, rel);
        const rendered = await readFile(target);
        await writeFile(target, '{"foreign":true}\n');
        git(dir, 'add', rel);
        await writeFile(target, rendered);
        return { target, rendered, staged: indexed(dir, rel) };
      };

      const s1 = await withPendingRender();
      const held1 = await stageForeign(s1.dest, RENDER_REL);
      const aside1 = await setAsideHaiveProjections(db, s1.payload.repositoryId, s1.dest);
      check(
        'S1: a foreign edit staged to render.json refuses the set-aside, names the file, and keeps the index blob',
        aside1.outcome === 'refused' &&
          aside1.file === RENDER_REL &&
          indexed(s1.dest, RENDER_REL) === held1.staged &&
          (await readFile(held1.target)).equals(held1.rendered),
        { aside1, now: indexed(s1.dest, RENDER_REL), staged: held1.staged },
      );

      const s2 = await cloned();
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: s2.payload.repositoryId, origin: 'user' },
      );
      await writePlanMirror(db, s2.payload.repositoryId, s2.dest);
      const held2 = await stageForeign(s2.dest, PLAN_REL);
      const aside2 = await setAsideHaiveProjections(db, s2.payload.repositoryId, s2.dest);
      check(
        'S2: a foreign edit staged to plan.json refuses the set-aside, names the file, and keeps the index blob',
        aside2.outcome === 'refused' &&
          aside2.file === PLAN_REL &&
          indexed(s2.dest, PLAN_REL) === held2.staged &&
          (await readFile(held2.target)).equals(held2.rendered),
        { aside2, now: indexed(s2.dest, PLAN_REL), staged: held2.staged },
      );

      const m3 = await cloned();
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m3.payload.repositoryId, origin: 'user' },
      );
      await writePlanMirror(db, m3.payload.repositoryId, m3.dest);
      const m3InHead = git(m3.dest, 'ls-tree', 'HEAD', '--', PLAN_REL);
      git(m3.dest, 'add', '--chmod=+x', '--', PLAN_REL);
      const asideM3 = await setAsideHaiveProjections(db, m3.payload.repositoryId, m3.dest);
      const m3Mode = git(m3.dest, 'ls-files', '-s', '--', PLAN_REL).split(' ')[0];
      check(
        "M3: a projection HEAD lacks, staged executable with Haive's bytes, refuses the set-aside and keeps its mode",
        m3InHead === '' &&
          asideM3.outcome === 'refused' &&
          asideM3.file === PLAN_REL &&
          m3Mode === '100755',
        { m3InHead, asideM3, m3Mode },
      );

      // R1. `.haive-data/state` itself as an untracked file is no projection Haive writes: refused, kept.
      const bareR1 = path.join(tmp, 'origin-r1.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', bareR1);
      const seedR1 = path.join(tmp, 'seed-r1');
      git(tmp, 'clone', '-q', `file://${bareR1}`, seedR1);
      await commitFile(seedR1, 'README.md', 'seed\n', 'seed');
      git(seedR1, 'push', '-q', 'origin', 'HEAD:main');
      const r1 = await cloned(bareR1);
      const stateRoot = path.join(r1.dest, '.haive-data', 'state');
      await mkdir(path.dirname(stateRoot), { recursive: true });
      await writeFile(stateRoot, 'a person wrote this\n');
      const asideR1 = await setAsideHaiveProjections(db, r1.payload.repositoryId, r1.dest);
      const keptR1 = await readFile(stateRoot, 'utf8').catch(() => null);
      check(
        'R1: an untracked file at .haive-data/state refuses the set-aside, is named, and is kept',
        asideR1.outcome === 'refused' &&
          asideR1.file === '.haive-data/state' &&
          keptR1 === 'a person wrote this\n',
        { asideR1, keptR1 },
      );

      // D1. A plan deleted in the database, whose deletion is not committed yet, holds the move: a restore
      // would bring HEAD's plan back and the sync after the move would read it in as a new plan.
      const d1 = await cloned();
      const d1Id = d1.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: d1Id, origin: 'user' },
      );
      await writePlanMirror(db, d1Id, d1.dest);
      git(d1.dest, 'add', '--', PLAN_REL, HAIVE_DATA_FILES.planMarkdown);
      git(d1.dest, 'commit', '-q', '-m', 'plan');
      await db.delete(schema.planNodes).where(eq(schema.planNodes.repositoryId, d1Id));
      await writePlanMirror(db, d1Id, d1.dest);
      const exists = () =>
        readFile(path.join(d1.dest, PLAN_REL)).then(
          () => true,
          () => false,
        );
      const deleted = !(await exists());
      const asideD1 = await setAsideHaiveProjections(db, d1Id, d1.dest);
      check(
        "D1: a plan deleted and not yet saved refuses the set-aside, so HEAD's plan is not brought back",
        deleted && asideD1.outcome === 'refused' && asideD1.file === PLAN_REL && !(await exists()),
        { deleted, asideD1, back: await exists() },
      );

      // R2. A staged plan.md HEAD lacks whose working copy changed again is taken out of the index too.
      const r2 = await cloned();
      const r2Id = r2.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: r2Id, origin: 'user' },
      );
      await writePlanMirror(db, r2Id, r2.dest);
      const mdRel = HAIVE_DATA_FILES.planMarkdown;
      git(r2.dest, 'add', '--', mdRel);
      await writeFile(path.join(r2.dest, mdRel), '# rewritten after staging\n');
      const asideR2 = await setAsideHaiveProjections(db, r2Id, r2.dest);
      const stagedR2 = git(r2.dest, 'ls-files', '-s', '--', mdRel);
      check(
        'R2: a staged plan.md whose working copy changed again leaves the index with the set-aside',
        asideR2.outcome === 'set-aside' && stagedR2 === '',
        { asideR2, stagedR2 },
      );

      // I1b and I2b stage plan.md for the set-aside; a person then stages other bytes there as the index swap runs.
      const stagedPlanMd = async (...addFlags: string[]) => {
        const c = await cloned();
        const id = c.payload.repositoryId;
        await applyPlanPatch(
          db,
          { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
          { repositoryId: id, origin: 'user' },
        );
        await writePlanMirror(db, id, c.dest);
        git(c.dest, 'add', ...addFlags, '--', mdRel);
        return { id, dest: c.dest };
      };
      const stagePerson = async (
        dest: string,
        body = '# staged by a person during the index swap\n',
      ) => {
        await writeFile(path.join(dest, mdRel), body);
        git(dest, 'add', '--', mdRel);
        return git(dest, 'ls-files', '-s', '--', mdRel);
      };

      // I1b. Bytes a person stages between the set-aside's read of the index and its swap stay in the index.
      const i1 = await stagedPlanMd();
      let i1Staged = '';
      restoreFaults.beforeIndexSwap = async () => {
        delete restoreFaults.beforeIndexSwap;
        i1Staged = await stagePerson(i1.dest);
      };
      let asideI1;
      try {
        asideI1 = await setAsideHaiveProjections(db, i1.id, i1.dest);
      } finally {
        delete restoreFaults.beforeIndexSwap;
      }
      const i1After = git(i1.dest, 'ls-files', '-s', '--', mdRel);
      check(
        'I1b: bytes staged while the set-aside swaps the index entry of plan.md stay in the index',
        i1Staged !== '' && i1After === i1Staged,
        { outcome: asideI1.outcome, i1Staged, i1After },
      );

      // I2b. Bytes a person stages between the put-back's read of the index and its swap stay in the index.
      const i2 = await stagedPlanMd();
      const asideI2 = await setAsideHaiveProjections(db, i2.id, i2.dest);
      let i2Staged = '';
      restoreFaults.beforeIndexPutBack = async () => {
        delete restoreFaults.beforeIndexPutBack;
        i2Staged = await stagePerson(i2.dest);
      };
      try {
        if (asideI2.outcome === 'set-aside') {
          await putBackProjections(db, i2.id, i2.dest, asideI2.kept);
        }
      } finally {
        delete restoreFaults.beforeIndexPutBack;
      }
      const i2After = git(i2.dest, 'ls-files', '-s', '--', mdRel);
      check(
        'I2b: bytes staged while the put-back swaps the index entry of plan.md stay in the index',
        asideI2.outcome === 'set-aside' && i2Staged !== '' && i2After === i2Staged,
        { outcome: asideI2.outcome, i2Staged, i2After },
      );

      // I1c and I2c track plan.md in HEAD under an earlier heading, so the swap is a patch git matches by hunk context.
      const trackedPlanMd = async () => {
        const c = await stagedPlanMd();
        const file = path.join(c.dest, mdRel);
        const staged = await readFile(file, 'utf8');
        const head = staged.replace(/^.*\n/, '# an earlier heading\n');
        await writeFile(file, head);
        git(c.dest, 'add', '--', mdRel);
        git(c.dest, 'commit', '-q', '-m', 'an earlier plan.md');
        await writeFile(file, staged);
        git(c.dest, 'add', '--', mdRel);
        return { ...c, staged, head };
      };

      // I1c. Haive's staged lines plus one a person appends as the swap runs are not overwritten by a patch matching only context.
      const i1c = await trackedPlanMd();
      let i1cStaged = '';
      restoreFaults.beforeIndexSwap = async () => {
        delete restoreFaults.beforeIndexSwap;
        i1cStaged = await stagePerson(i1c.dest, `${i1c.staged}a line a person appended\n`);
      };
      let asideI1c;
      try {
        asideI1c = await setAsideHaiveProjections(db, i1c.id, i1c.dest);
      } finally {
        delete restoreFaults.beforeIndexSwap;
      }
      const i1cAfter = git(i1c.dest, 'ls-files', '-s', '--', mdRel);
      check(
        "I1c: a line appended to the staged plan.md while the set-aside swaps the entry leaves exactly the person's blob in the index",
        i1cStaged !== '' && i1cAfter === i1cStaged,
        { outcome: asideI1c.outcome, i1cStaged, i1cAfter },
      );

      // I2c. HEAD's lines plus one a person appends as the put-back swaps stay exactly as staged.
      const i2c = await trackedPlanMd();
      const asideI2c = await setAsideHaiveProjections(db, i2c.id, i2c.dest);
      let i2cStaged = '';
      restoreFaults.beforeIndexPutBack = async () => {
        delete restoreFaults.beforeIndexPutBack;
        i2cStaged = await stagePerson(i2c.dest, `${i2c.head}a line a person appended\n`);
      };
      try {
        if (asideI2c.outcome === 'set-aside') {
          await putBackProjections(db, i2c.id, i2c.dest, asideI2c.kept);
        }
      } finally {
        delete restoreFaults.beforeIndexPutBack;
      }
      const i2cAfter = git(i2c.dest, 'ls-files', '-s', '--', mdRel);
      check(
        "I2c: a line appended to HEAD's plan.md while the put-back swaps the entry leaves exactly the person's blob in the index",
        asideI2c.outcome === 'set-aside' && i2cStaged !== '' && i2cAfter === i2cStaged,
        { outcome: asideI2c.outcome, i2cStaged, i2cAfter },
      );

      // I3. A git failure that is not a lost race, a held index.lock here, is thrown with git's own message.
      const i3 = await stagedPlanMd();
      const i3Lock = path.join(i3.dest, '.git', 'index.lock');
      restoreFaults.beforeIndexSwap = async () => {
        delete restoreFaults.beforeIndexSwap;
        await writeFile(i3Lock, '');
      };
      let i3Error = '';
      try {
        await setAsideHaiveProjections(db, i3.id, i3.dest);
      } catch (err) {
        i3Error = err instanceof Error ? err.message : String(err);
      } finally {
        delete restoreFaults.beforeIndexSwap;
        await rm(i3Lock, { force: true });
      }
      check(
        'I3: an index.lock held while the set-aside swaps the entry is thrown',
        /index\.lock/.test(i3Error),
        { i3Error },
      );

      // I4. An intent-to-add entry is absent from `git diff --cached`, so the set-aside refuses and names the cause.
      const i4 = await stagedPlanMd('-N');
      const asideI4 = await setAsideHaiveProjections(db, i4.id, i4.dest);
      check(
        'I4: a plan.md marked intent-to-add refuses the set-aside and says why',
        asideI4.outcome === 'refused' &&
          asideI4.file === mdRel &&
          /intent-to-add/.test(asideI4.reason),
        asideI4,
      );

      // I5. A staged plan.md is not judged, and the patch that swaps a 40 MiB copy for a 40 MiB HEAD holds both.
      const i5 = await stagedPlanMd();
      const i5Md = path.join(i5.dest, mdRel);
      const i5Haives = await readFile(i5Md);
      for (const [byte, committed] of [
        ['y', true],
        ['x', false],
      ] as const) {
        await writeFile(i5Md, Buffer.alloc(40 * 1024 * 1024, byte));
        git(i5.dest, 'add', '--', mdRel);
        if (committed) git(i5.dest, 'commit', '-q', '-m', 'a large plan.md');
      }
      await writeFile(i5Md, i5Haives);
      let asideI5;
      let i5Error = '';
      try {
        asideI5 = await setAsideHaiveProjections(db, i5.id, i5.dest);
      } catch (err) {
        i5Error = err instanceof Error ? err.message : String(err);
      }
      const i5Index = git(i5.dest, 'rev-parse', `:${mdRel}`);
      const i5Head = git(i5.dest, 'rev-parse', `HEAD:${mdRel}`);
      check(
        "I5: a 40 MiB staged plan.md that differs from HEAD's 40 MiB one is set aside, and the index holds HEAD's",
        asideI5?.outcome === 'set-aside' && i5Index === i5Head,
        { outcome: asideI5?.outcome, i5Error, i5Index, i5Head },
      );

      // M4. A projection neither HEAD nor the index holds shows its mode only on disk: an executable
      // plan.json with Haive's bytes refuses the set-aside and keeps its mode.
      const m4 = await cloned();
      const m4Id = m4.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m4Id, origin: 'user' },
      );
      await writePlanMirror(db, m4Id, m4.dest);
      const m4Plan = path.join(m4.dest, PLAN_REL);
      await chmod(m4Plan, 0o755);
      const m4Tracked = git(m4.dest, 'ls-files', '--', PLAN_REL);
      const asideM4 = await setAsideHaiveProjections(db, m4Id, m4.dest);
      const m4Mode = ((await stat(m4Plan).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'M4: an untracked executable plan.json refuses the set-aside and keeps its mode',
        m4Tracked === '' &&
          asideM4.outcome === 'refused' &&
          asideM4.file === PLAN_REL &&
          m4Mode === 0o755,
        { m4Tracked, asideM4, m4Mode: m4Mode.toString(8) },
      );

      // M5. An untracked plan.json at a non-executable mode other than 0644 is put back at that mode.
      const m5 = await cloned();
      const m5Id = m5.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m5Id, origin: 'user' },
      );
      await writePlanMirror(db, m5Id, m5.dest);
      const m5Plan = path.join(m5.dest, PLAN_REL);
      await chmod(m5Plan, 0o600);
      const asideM5 = await setAsideHaiveProjections(db, m5Id, m5.dest);
      const m5Gone = (await stat(m5Plan).catch(() => null)) === null;
      if (asideM5.outcome === 'set-aside') {
        await putBackProjections(db, m5Id, m5.dest, asideM5.kept);
      }
      const m5Mode = ((await stat(m5Plan).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'M5: an untracked plan.json put back after a set-aside keeps its 0600 mode',
        asideM5.outcome === 'set-aside' && m5Gone && m5Mode === 0o600,
        { outcome: asideM5.outcome, m5Gone, m5Mode: m5Mode.toString(8) },
      );

      // O4. An owner change landing after the capture of an untracked plan.json keeps the file.
      const o4 = await cloned();
      const o4Id = o4.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: o4Id, origin: 'user' },
      );
      await writePlanMirror(db, o4Id, o4.dest);
      const o4Plan = path.join(o4.dest, PLAN_REL);
      const o4Was = await stat(o4Plan);
      const o4Gid = process.getgroups?.().find((gid) => gid !== o4Was.gid);
      if (o4Gid === undefined) {
        check('O4: skipped, the process belongs to no second group to give the file to', true);
      } else {
        let o4Fired = false;
        restoreFaults.beforeRestore = async () => {
          delete restoreFaults.beforeRestore;
          o4Fired = true;
          await chown(o4Plan, o4Was.uid, o4Gid);
        };
        let asideO4;
        try {
          asideO4 = await setAsideHaiveProjections(db, o4Id, o4.dest);
        } finally {
          delete restoreFaults.beforeRestore;
        }
        if (asideO4.outcome === 'set-aside') {
          await putBackProjections(db, o4Id, o4.dest, asideO4.kept);
        }
        const o4Now = await stat(o4Plan).catch(() => null);
        check(
          'O4: an owner change landing before the restore of an untracked plan.json is kept',
          o4Fired && o4Now?.gid === o4Gid,
          { o4Fired, outcome: asideO4.outcome, gid: o4Now?.gid, want: o4Gid, was: o4Was.gid },
        );
      }

      // M6. A tracked plan.md deleted in the checkout comes back from HEAD for the move; a mode a person
      // gives it meanwhile keeps it out of the put-back's removal.
      const m6 = await cloned();
      const m6Id = m6.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m6Id, origin: 'user' },
      );
      await writePlanMirror(db, m6Id, m6.dest);
      const m6Md = path.join(m6.dest, HAIVE_DATA_FILES.planMarkdown);
      git(m6.dest, 'add', '--', PLAN_REL, HAIVE_DATA_FILES.planMarkdown);
      git(m6.dest, 'commit', '-q', '-m', 'plan');
      await rm(m6Md);
      const asideM6 = await setAsideHaiveProjections(db, m6Id, m6.dest);
      const m6Back = (await stat(m6Md).catch(() => null)) !== null;
      await chmod(m6Md, 0o600).catch(() => undefined);
      if (asideM6.outcome === 'set-aside') {
        await putBackProjections(db, m6Id, m6.dest, asideM6.kept);
      }
      const m6Mode = ((await stat(m6Md).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'M6: a restored file whose mode a person changed is not removed by the put-back',
        asideM6.outcome === 'set-aside' && m6Back && m6Mode === 0o600,
        { outcome: asideM6.outcome, m6Back, m6Mode: m6Mode.toString(8) },
      );

      // X6. A tracked plan.md deleted in the checkout comes back from HEAD for the move, and the put-back removes it again.
      const x6 = await cloned();
      const x6Id = x6.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: x6Id, origin: 'user' },
      );
      await writePlanMirror(db, x6Id, x6.dest);
      const x6Md = path.join(x6.dest, HAIVE_DATA_FILES.planMarkdown);
      git(x6.dest, 'add', '--', PLAN_REL, HAIVE_DATA_FILES.planMarkdown);
      git(x6.dest, 'commit', '-q', '-m', 'plan');
      await rm(x6Md);
      const asideX6 = await setAsideHaiveProjections(db, x6Id, x6.dest);
      const x6Back = (await stat(x6Md).catch(() => null)) !== null;
      if (asideX6.outcome === 'set-aside') {
        await putBackProjections(db, x6Id, x6.dest, asideX6.kept);
      }
      const x6Gone = (await stat(x6Md).catch(() => null)) === null;
      check(
        'X6: a tracked plan.md deleted locally is restored for the move and removed again by the put-back',
        asideX6.outcome === 'set-aside' && x6Back && x6Gone,
        { outcome: asideX6.outcome, x6Back, x6Gone },
      );

      // M7. A generated plan.md larger than plan.json's cap is still held and put back whole.
      const m7 = await cloned();
      const m7Id = m7.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m7Id, origin: 'user' },
      );
      await writePlanMirror(db, m7Id, m7.dest);
      const m7Md = path.join(m7.dest, HAIVE_DATA_FILES.planMarkdown);
      const m7Big = Buffer.alloc(17 * 1024 * 1024, 'x');
      await writeFile(m7Md, m7Big);
      const asideM7 = await setAsideHaiveProjections(db, m7Id, m7.dest);
      const m7Gone = (await stat(m7Md).catch(() => null)) === null;
      if (asideM7.outcome === 'set-aside') {
        await putBackProjections(db, m7Id, m7.dest, asideM7.kept);
      }
      const m7Back = (await readFile(m7Md).catch(() => null))?.equals(m7Big) === true;
      check(
        'M7: a plan.md over 16 MiB is set aside and put back whole',
        asideM7.outcome === 'set-aside' && m7Gone && m7Back,
        { outcome: asideM7.outcome, m7Gone, m7Back },
      );

      // M8. An untracked plan.json at 0600 that a move sets aside and the resync re-creates keeps that mode.
      for (const via of ['refresh', '00a'] as const) {
        const m8 = await cloned();
        const m8Id = m8.payload.repositoryId;
        await applyPlanPatch(
          db,
          { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
          { repositoryId: m8Id, origin: 'user' },
        );
        await writePlanMirror(db, m8Id, m8.dest);
        const m8Plan = path.join(m8.dest, PLAN_REL);
        await chmod(m8Plan, 0o600);
        const m8Head = git(m8.dest, 'rev-parse', 'HEAD');
        await push(`m8-${via}-upstream.txt`, 'x\n');
        const m8Moved = await moveVia(via, m8);
        const m8Mode = ((await stat(m8Plan).catch(() => null))?.mode ?? 0) & 0o777;
        check(
          `M8: ${via}: an untracked plan.json at 0600 keeps that mode across a move of the checkout`,
          git(m8.dest, 'rev-parse', 'HEAD') !== m8Head && m8Mode === 0o600,
          { m8Moved, m8Mode: m8Mode.toString(8) },
        );
      }

      // M12. A mode a person gives the re-created plan.json before the restore is theirs and is kept.
      const m12 = await cloned();
      const m12Id = m12.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m12Id, origin: 'user' },
      );
      await writePlanMirror(db, m12Id, m12.dest);
      const m12Plan = path.join(m12.dest, PLAN_REL);
      await chmod(m12Plan, 0o600);
      const m12Head = git(m12.dest, 'rev-parse', 'HEAD');
      await push('m12-upstream.txt', 'x\n');
      let m12Fired = false;
      restoreFaults.beforeKeptMetadata = async () => {
        delete restoreFaults.beforeKeptMetadata;
        m12Fired = true;
        await chmod(m12Plan, 0o640);
      };
      let m12Moved;
      try {
        m12Moved = await moveVia('refresh', m12);
      } finally {
        delete restoreFaults.beforeKeptMetadata;
      }
      const m12Mode = ((await stat(m12Plan).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'M12: a mode a person gives the re-created plan.json before the restore is kept',
        m12Fired && git(m12.dest, 'rev-parse', 'HEAD') !== m12Head && m12Mode === 0o640,
        { m12Fired, m12Moved, m12Mode: m12Mode.toString(8) },
      );

      // M13. A group a person gives the re-created plan.json before the restore is theirs and is kept.
      const m13Gid = process.getgroups?.().find((gid) => gid !== process.getgid?.());
      if (m13Gid === undefined) {
        check('M13: skipped — this user has no second group to change to', true, {});
      } else {
        const m13 = await cloned();
        const m13Id = m13.payload.repositoryId;
        await applyPlanPatch(
          db,
          { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
          { repositoryId: m13Id, origin: 'user' },
        );
        await writePlanMirror(db, m13Id, m13.dest);
        const m13Plan = path.join(m13.dest, PLAN_REL);
        const m13Head = git(m13.dest, 'rev-parse', 'HEAD');
        await push('m13-upstream.txt', 'x\n');
        let m13Fired = false;
        restoreFaults.beforeKeptMetadata = async () => {
          delete restoreFaults.beforeKeptMetadata;
          m13Fired = true;
          await chown(m13Plan, process.getuid?.() ?? 0, m13Gid);
        };
        try {
          await moveVia('refresh', m13);
        } finally {
          delete restoreFaults.beforeKeptMetadata;
        }
        const m13Gidnow = (await stat(m13Plan).catch(() => null))?.gid;
        check(
          'M13: a group a person gives the re-created plan.json before the restore is kept',
          m13Fired && git(m13.dest, 'rev-parse', 'HEAD') !== m13Head && m13Gidnow === m13Gid,
          { m13Fired, m13Gid, m13Gidnow },
        );
      }

      // M9 and M11 need a remote of their own: the shared one's committed record already holds every directory.
      const untrackedRecord = async (name: string) => {
        const origin = path.join(tmp, `origin-${name}.git`);
        git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
        const seedDir = path.join(tmp, `seed-${name}`);
        git(tmp, 'clone', '-q', `file://${origin}`, seedDir);
        await commitFile(seedDir, 'README.md', 'seed\n', 'seed');
        git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
        const c = await cloned(origin);
        const id = c.payload.repositoryId;
        await db
          .update(schema.repositories)
          .set({ renderContext: column() })
          .where(eq(schema.repositories.id, id));
        await markProjectStateDirty(db, id);
        await sweepDirtyProjectStates(db);
        const dir = path.join(c.dest, path.dirname(RENDER_REL));
        const root = path.join(c.dest, '.haive-data/state');
        await chmod(dir, 0o700);
        await chmod(root, 0o750);
        const untracked = git(c.dest, 'status', '--porcelain', '--', RENDER_REL);
        const modeOf = async (p: string) => ((await stat(p).catch(() => null))?.mode ?? 0) & 0o7777;
        const modes = () => Promise.all([modeOf(dir), modeOf(root)]);
        return { c, id, seedDir, dir, untracked, held: await readdir(dir), modes };
      };

      // M9. The state directories the set-aside empties and removes come back at the modes they had.
      for (const via of ['refresh', '00a'] as const) {
        const m9 = await untrackedRecord(`m9-${via}`);
        const m9Head = git(m9.c.dest, 'rev-parse', 'HEAD');
        await commitFile(m9.seedDir, 'm9-upstream.txt', 'x\n', 'upstream');
        git(m9.seedDir, 'push', '-q', 'origin', 'HEAD:main');
        const m9Moved = await moveVia(via, m9.c);
        const m9Advanced = git(m9.c.dest, 'rev-parse', 'HEAD') !== m9Head;
        const m9Modes = (await m9.modes()).map((m) => m.toString(8));
        check(
          `M9: ${via}: the state directories the set-aside empties keep their modes across a move of the checkout`,
          m9.untracked.startsWith('??') &&
            isDeepEqual(m9.held, ['render.json']) &&
            m9Advanced &&
            isDeepEqual(m9Modes, ['700', '750']),
          { untracked: m9.untracked, held: m9.held, m9Moved, m9Advanced, m9Modes },
        );
      }

      // M10. A throw after the move landed re-syncs, and the untracked plan.json still gets its mode back.
      const m10 = await cloned();
      const m10Id = m10.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m10Id, origin: 'user' },
      );
      await writePlanMirror(db, m10Id, m10.dest);
      const m10Plan = path.join(m10.dest, PLAN_REL);
      await chmod(m10Plan, 0o600);
      const m10Head = git(m10.dest, 'rev-parse', 'HEAD');
      await push('m10-upstream.txt', 'x\n');
      const asideM10 = await setAsideHaiveProjections(db, m10Id, m10.dest);
      git(m10.dest, 'fetch', '-q', 'origin', 'main');
      git(m10.dest, 'merge', '-q', '--ff-only', 'origin/main');
      const m10Err = new Error('the move threw after it landed');
      let m10Thrown: unknown = null;
      if (asideM10.outcome === 'set-aside') {
        try {
          await recoverAfterMoveFailure(db, m10Id, m10.dest, asideM10.kept, m10Head, m10Err);
        } catch (err) {
          m10Thrown = err;
        }
      }
      const m10Mode = ((await stat(m10Plan).catch(() => null))?.mode ?? 0) & 0o777;
      check(
        'M10: a throw after the move landed still gives an untracked plan.json its 0600 mode back',
        asideM10.outcome === 'set-aside' &&
          git(m10.dest, 'rev-parse', 'HEAD') !== m10Head &&
          m10Thrown === m10Err &&
          m10Mode === 0o600,
        { outcome: asideM10.outcome, m10Thrown: String(m10Thrown), m10Mode: m10Mode.toString(8) },
      );

      // M11. The same directories come back at those modes when no move follows and the files are put back.
      const m11 = await untrackedRecord('m11');
      const m11Render = await readFile(path.join(m11.c.dest, RENDER_REL));
      const asideM11 = await setAsideHaiveProjections(db, m11.id, m11.c.dest);
      const m11Gone = (await stat(m11.dir).catch(() => null)) === null;
      if (asideM11.outcome === 'set-aside') {
        await putBackProjections(db, m11.id, m11.c.dest, asideM11.kept);
      }
      const m11Back = await readFile(path.join(m11.c.dest, RENDER_REL)).catch(() => null);
      const m11Modes = (await m11.modes()).map((m) => m.toString(8));
      check(
        'M11: the state directories the set-aside empties keep their modes when the files are put back',
        m11.untracked.startsWith('??') &&
          isDeepEqual(m11.held, ['render.json']) &&
          asideM11.outcome === 'set-aside' &&
          m11Gone &&
          m11Back?.equals(m11Render) === true &&
          isDeepEqual(m11Modes, ['700', '750']),
        { untracked: m11.untracked, outcome: asideM11.outcome, m11Gone, m11Modes },
      );

      // P2. A lone plan.md in a repository whose database holds no plan is not Haive's: refused and kept.
      const p2 = await cloned();
      const p2Md = path.join(p2.dest, HAIVE_DATA_FILES.planMarkdown);
      await mkdir(path.dirname(p2Md), { recursive: true });
      await writeFile(p2Md, '# notes a person keeps here\n');
      const asideP2 = await setAsideHaiveProjections(db, p2.payload.repositoryId, p2.dest);
      const keptP2 = await readFile(p2Md, 'utf8').catch(() => null);
      check(
        'P2: a lone plan.md with no plan in the database refuses the set-aside and is kept',
        asideP2.outcome === 'refused' &&
          asideP2.file === HAIVE_DATA_FILES.planMarkdown &&
          keptP2 === '# notes a person keeps here\n',
        { asideP2, keptP2 },
      );

      // S3. With no sync row this install never wrote state: a tracked state file deleted locally is not
      // Haive's pending deletion, so the set-aside refuses it instead of bringing HEAD's back.
      const s3 = await committedRecord();
      const s3Id = s3.payload.repositoryId;
      await db
        .delete(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s3Id));
      await rm(path.join(s3.dest, RENDER_REL));
      const asideS3 = await setAsideHaiveProjections(db, s3Id, s3.dest);
      const backS3 = await readFile(path.join(s3.dest, RENDER_REL)).then(
        () => true,
        () => false,
      );
      check(
        'S3: a state file deleted with no sync row refuses the set-aside and stays deleted',
        asideS3.outcome === 'refused' && asideS3.file === RENDER_REL && !backS3,
        { asideS3, backS3 },
      );

      // 11l-2. A mode change is not in the blob id: a staged chmod, or one only in the working tree, on a
      // file holding Haive's bytes is a person's change, and returning the path to HEAD would lose it.
      const indexMode = (dir: string, rel: string) =>
        git(dir, 'ls-files', '-s', '--', rel).split(' ')[0];
      const m1 = await withPendingRender();
      git(m1.dest, 'update-index', '--chmod=+x', RENDER_REL);
      const m1Mode = indexMode(m1.dest, RENDER_REL);
      const m1Bytes = await readFile(path.join(m1.dest, RENDER_REL));
      const aside3 = await setAsideHaiveProjections(db, m1.payload.repositoryId, m1.dest);
      check(
        "M1: a staged mode change on render.json holding Haive's bytes refuses the set-aside, names the file, and keeps the index mode",
        aside3.outcome === 'refused' &&
          aside3.file === RENDER_REL &&
          m1Mode === '100755' &&
          indexMode(m1.dest, RENDER_REL) === '100755' &&
          (await readFile(path.join(m1.dest, RENDER_REL))).equals(m1Bytes),
        { aside3, mode: indexMode(m1.dest, RENDER_REL), was: m1Mode },
      );

      const m2 = await cloned();
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: m2.payload.repositoryId, origin: 'user' },
      );
      await writePlanMirror(db, m2.payload.repositoryId, m2.dest);
      git(m2.dest, 'add', '.haive-data');
      git(m2.dest, 'commit', '-q', '-m', 'plan');
      const m2Target = path.join(m2.dest, PLAN_REL);
      const m2Bytes = await readFile(m2Target);
      await chmod(m2Target, 0o755);
      const aside4 = await setAsideHaiveProjections(db, m2.payload.repositoryId, m2.dest);
      const m2Mode = (await stat(m2Target)).mode & 0o777;
      check(
        "M2: a working-tree mode change on plan.json holding Haive's bytes refuses the set-aside, names the file, and keeps the mode",
        aside4.outcome === 'refused' &&
          aside4.file === PLAN_REL &&
          m2Mode === 0o755 &&
          (await readFile(m2Target)).equals(m2Bytes),
        { aside4, mode: m2Mode.toString(8) },
      );

      // 11l-3. A sweep that takes the lock between the two transactions rewrites the same bytes and
      // clears the mark the first raised: the second must see the row moved and go round again, so a crash
      // after the restore still leaves the row dirty.
      const markOf = async (id: string) =>
        (
          await db
            .select({
              revision: schema.planMirrorState.revision,
              written: schema.planMirrorState.writtenRevision,
            })
            .from(schema.planMirrorState)
            .where(eq(schema.planMirrorState.repositoryId, id))
        )[0]!;
      const crashAfterRestore = new Error('crash after the restore');
      const interposed = async (
        sweep: () => Promise<unknown>,
        run: () => Promise<unknown>,
      ): Promise<{ sweeps: number; thrown: unknown }> => {
        let sweeps = 0;
        restoreFaults.afterBase = async () => {
          sweeps += 1;
          if (sweeps === 1) await sweep();
        };
        restoreFaults.afterRestore = () => {
          throw crashAfterRestore;
        };
        let thrown: unknown = null;
        try {
          await run();
        } catch (err) {
          thrown = err;
        } finally {
          delete restoreFaults.afterBase;
          delete restoreFaults.afterRestore;
        }
        return { sweeps, thrown };
      };

      const g1 = await cloned();
      const g1Id = g1.payload.repositoryId;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Root' }] },
        { repositoryId: g1Id, origin: 'user' },
      );
      await writePlanMirror(db, g1Id, g1.dest);
      git(g1.dest, 'add', '.haive-data');
      git(g1.dest, 'commit', '-q', '-m', 'plan');
      const g1Root = (await db.query.planNodes.findFirst({
        where: eq(schema.planNodes.repositoryId, g1Id),
      }))!;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: g1Root.id, title: 'Root, edited here' }] },
        { repositoryId: g1Id, origin: 'user' },
      );
      await writePlanMirror(db, g1Id, g1.dest);
      const g1Run = await interposed(
        () => writePlanMirror(db, g1Id, g1.dest),
        () => setAsideHaiveProjections(db, g1Id, g1.dest),
      );
      const g1Mark = await markOf(g1Id);
      const g1AtHead = !(await readFile(path.join(g1.dest, PLAN_REL), 'utf8')).includes(
        'edited here',
      );
      await writePlanMirror(db, g1Id, g1.dest);
      const g1After = await readFile(path.join(g1.dest, PLAN_REL), 'utf8');
      check(
        'G1: a plan sweep between the two transactions sends the set-aside round again, and a crash after the restore leaves the plan row dirty for the next sweep',
        g1Run.thrown === crashAfterRestore &&
          g1Run.sweeps === 2 &&
          g1Mark.written < g1Mark.revision &&
          !g1AtHead &&
          g1After.includes('Root, edited here'),
        { g1Run: { ...g1Run, thrown: String(g1Run.thrown) }, g1Mark, g1AtHead },
      );
    }

    // 11m. A set-aside never asks the pool for a connection while its own transaction holds one: two of
    // them on two repositories finish on a pool of two connections. Each waits, inside its transaction,
    // for the other to be inside its own.
    {
      const a = await withPendingRender();
      const b = await withPendingRender();
      const capped = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
      let arrived = 0;
      let release: () => void = () => undefined;
      const both = new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, 3000).unref();
      });
      const barrier = () => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 2) {
            arrived += 1;
            if (arrived === 2) release();
            await both;
          }
          return 0;
        };
      };
      const run = (c: typeof a) =>
        setAsideHaiveProjections(
          drizzle(capped, { schema }),
          c.payload.repositoryId,
          c.dest,
          barrier(),
        );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 10_000);
      });
      const settled = await Promise.race([Promise.all([run(a), run(b)]), timeout]);
      clearTimeout(timer);
      check(
        'P1: two set-asides on a pool of two connections both finish within 10 s',
        settled !== 'timeout' && settled.every((r) => r.outcome === 'set-aside'),
        settled,
      );
      await capped.end({ timeout: 5 });
    }

    // 12. plan.json holding the bytes Haive last wrote is set aside, then re-rendered over the new head.
    {
      const c = await cloned();
      const id = c.payload.repositoryId;
      await applyPlanPatch(
        db,
        {
          ops: [
            { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Plan' },
            { op: 'upsert', nodeRef: 'one', parentRef: 'root', title: 'One' },
            { op: 'upsert', nodeRef: 'two', parentRef: 'root', title: 'Two' },
          ],
        },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      git(c.dest, 'add', '.haive-data');
      git(c.dest, 'commit', '-q', '-m', 'plan');
      git(c.dest, 'push', '-q', 'origin', 'HEAD:main');
      git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
      const titles = (text: string) =>
        (JSON.parse(text) as { nodes: { title: string }[] }).nodes.map((n) => n.title).sort();
      const nodes = await db.query.planNodes.findMany({
        where: eq(schema.planNodes.repositoryId, id),
      });
      const one = nodes.find((n) => n.title === 'One')!;
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: one.id, title: 'One, edited here' }] },
        { repositoryId: id, origin: 'user' },
      );
      await writePlanMirror(db, id, c.dest);
      const pending = git(c.dest, 'status', '--porcelain', '--', PLAN_REL);
      const theirs = JSON.parse(await readFile(path.join(seed, PLAN_REL), 'utf8')) as {
        nodes: { title: string }[];
      };
      theirs.nodes.find((n) => n.title === 'Two')!.title = 'Two, edited there';
      await writeFile(path.join(seed, PLAN_REL), `${JSON.stringify(theirs, null, 2)}\n`);
      const upstream = upstreamCommit('a teammate edits the plan', PLAN_REL);
      await handleRefresh(c.payload, db, storage);
      const now = titles(await readFile(path.join(c.dest, PLAN_REL), 'utf8'));
      const inDb = (
        await db.query.planNodes.findMany({ where: eq(schema.planNodes.repositoryId, id) })
      )
        .map((n) => n.title)
        .sort();
      check(
        'a plan.json holding what Haive last wrote is set aside for the move',
        pending.startsWith('M') && git(c.dest, 'rev-parse', 'HEAD') === upstream,
        { pending },
      );
      check(
        'and the plan is read in and re-rendered with both edits, in the database and in plan.json',
        isDeepEqual(inDb, ['One, edited here', 'Plan', 'Two, edited there']) &&
          isDeepEqual(now, ['One, edited here', 'Plan', 'Two, edited there']),
        { inDb, now },
      );
    }

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'REPO_REFRESH_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
      await rm(tmp, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
