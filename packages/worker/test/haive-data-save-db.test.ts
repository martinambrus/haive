import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { recordPlanMirrorError } from '../src/plan/mirror.js';
import * as planLocks from '@haive/shared/plan';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { initDatabase } from '../src/db.js';
import { gitRun } from '../src/repo/git-exec.js';
import * as commits from '../src/project-state/commit.js';
import * as refresh from '../src/project-state/refresh.js';
import * as writers from '../src/project-state/write.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { saveHaiveData } from '../src/project-state/save.js';

const url = process.env.HAIVE_DATA_SAVE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/haive_data_save_test'))
  throw new Error('Use a dedicated haive_data_save_test database for Haive data Save tests');
const identity = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const context = {
  projectInfo: { name: 'save' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: false,
  cliTargets: [],
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('expected Postgres lock wait did not occur');
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe.skipIf(!url)('Haive data Save on real Postgres', () => {
  let db: Database;
  let racer: Database;
  let root: string;
  let repoPath: string;
  let userId: string;
  let repositoryId: string;
  const save = (push = false) => saveHaiveData({ repositoryId, userId, push });
  const git = async (...args: string[]) => {
    const result = await gitRun(repoPath, args, identity);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  beforeAll(async () => {
    db = initDatabase(url!);
    racer = createDatabase(url!);
    root = await mkdtemp(join(tmpdir(), 'haive-data-save-db-'));
  });
  afterAll(async () => {
    await racer.$client.end({ timeout: 5 });
    await db.$client.end({ timeout: 5 });
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    userId = randomUUID();
    repositoryId = randomUUID();
    repoPath = join(root, repositoryId);
    await mkdir(repoPath);
    await git('init', '-q', '-b', 'main');
    await git('commit', '-q', '--allow-empty', '-m', 'initial');
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'data Save',
      source: 'blank',
      status: 'ready',
      storagePath: repoPath,
      renderContext: context,
    });
    await markProjectStateDirty(db, repositoryId);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
  async function question() {
    const [row] = await db
      .insert(schema.projectStateConflicts)
      .values({
        repositoryId,
        unit: 'project/render.json#projectInfo',
        base: { v: { name: 'base' } },
        local: { v: context.projectInfo },
        incoming: { v: context.projectInfo },
      })
      .returning();
    return row!;
  }
  it('flushes both projections into one commit and leaves a clean tree with no plan', async () => {
    const result = await save();
    expect(result).toMatchObject({
      outcome: 'saved',
      committed: true,
      pushed: false,
      refusal: null,
    });
    expect(result.files).toContain('.haive-data/state/project/render.json');
    expect(await git('status', '--porcelain')).toBe('');
    const [outbox] = await db
      .select()
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
    expect(outbox!.writtenRevision).toBe(outbox!.revision);
    expect(outbox!.writeIntent).toBeNull();
    expect(await save()).toMatchObject({ outcome: 'unchanged', committed: false });
  });
  it('never records data-scope flush failures as plan snapshot errors', async () => {
    await db.insert(schema.planMirrorState).values({
      repositoryId,
      revision: 0,
      writtenRevision: 0,
      lastError: 'prior snapshot diagnosis',
    });
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('data flush failure'));
    expect(await save()).toMatchObject({ outcome: 'failed', failure: { code: 'save_failed' } });
    const read = async () =>
      (
        await db
          .select()
          .from(schema.planMirrorState)
          .where(eq(schema.planMirrorState.repositoryId, repositoryId))
      )[0]!.lastError;
    expect(await read()).toBe('prior snapshot diagnosis');
    // Suppression belongs to this job's async chain, never to later ordinary writers.
    await recordPlanMirrorError(db, repositoryId, new Error('ordinary plan failure'));
    expect(await read()).toBe('ordinary plan failure');
  });
  it('works with both observer and plan-canvas switches off', async () => {
    const config = vi
      .spyOn(configService, 'getBoolean')
      .mockImplementation(async (key, fallback) =>
        key === CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED || key === CONFIG_KEYS.PLAN_CANVAS_ENABLED
          ? false
          : (fallback ?? false),
      );
    expect(await save()).toMatchObject({ committed: true, refusal: null });
    expect(
      config.mock.calls.filter(
        ([key]) =>
          key === CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED || key === CONFIG_KEYS.PLAN_CANVAS_ENABLED,
      ),
    ).toEqual([]);
  });
  it.each(['onboarding', 'onboarding_upgrade'] as const)(
    'refuses a live %s checkout holder without a commit',
    async (type) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({ userId, repositoryId, type, title: 'holder', status: 'paused' })
        .returning();
      const before = await git('rev-parse', 'HEAD');
      expect(await save()).toMatchObject({
        committed: false,
        refusal: { code: 'checkout_held', taskIds: [task!.id] },
      });
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      await db
        .update(schema.tasks)
        .set({ deadAt: new Date() })
        .where(eq(schema.tasks.id, task!.id));
      expect(await save()).toMatchObject({ committed: true, refusal: null });
    },
  );
  it.each(['reset', 'refresh'] as const)(
    'refuses a live %s root claim, but not an expired one',
    async (kind) => {
      await db
        .update(schema.repositories)
        .set({ rootClaimedAt: new Date(), rootClaimKind: kind })
        .where(eq(schema.repositories.id, repositoryId));
      const before = await git('rev-parse', 'HEAD');
      expect(await save()).toMatchObject({ committed: false, refusal: { code: 'root_claim' } });
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      await db
        .update(schema.repositories)
        .set({ rootClaimedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.repositories.id, repositoryId));
      expect(await save()).toMatchObject({ committed: true });
    },
  );
  it('refuses a journal without recovering or committing it', async () => {
    await db
      .update(schema.projectStateOutbox)
      .set({ writeIntent: {} })
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
    const before = await git('rev-parse', 'HEAD');
    expect(await save()).toMatchObject({ committed: false, refusal: { code: 'write_pending' } });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
  });
  it.each(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge'])(
    'refuses an open Git operation (%s)',
    async (mark) => {
      const before = await git('rev-parse', 'HEAD');
      if (mark !== 'rebase-merge') await writeFile(join(repoPath, '.git', mark), `${before}\n`);
      else await mkdir(join(repoPath, '.git', mark));
      expect(await save()).toMatchObject({ committed: false, refusal: { code: 'git_operation' } });
      expect(await git('rev-parse', 'HEAD')).toBe(before);
    },
  );
  it('surfaces the writer stable malformed RTK outcome without retrying', async () => {
    await save();
    const before = await git('rev-parse', 'HEAD');
    await mkdir(join(repoPath, '.haive-data/state/settings'), { recursive: true });
    await writeFile(join(repoPath, '.haive-data/state/settings/rtk-enabled.json'), '"yes"\n');
    const refreshSpy = vi.spyOn(refresh, 'refreshProjectStateOutcome');
    expect(await save()).toMatchObject({
      outcome: 'refused',
      committed: false,
      refusal: {
        code: 'unowned_malformed_rtk',
        file: '.haive-data/state/settings/rtk-enabled.json',
      },
    });
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    const [outbox] = await db
      .select()
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
    expect(outbox!.writtenRevision).toBeLessThan(outbox!.revision);
  });
  it('refuses a plan merge conversation and pending project-state questions', async () => {
    const before = await git('rev-parse', 'HEAD');
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, repositoryId, type: 'plan_merge', title: 'merge', status: 'running' })
      .returning();
    expect(await save()).toMatchObject({ refusal: { code: 'plan_merge', taskId: task!.id } });
    await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
    await question();
    expect(await save()).toMatchObject({
      refusal: { code: 'project_state_questions', units: ['project/render.json#projectInfo'] },
    });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
  });
  it('allows a pending plan question', async () => {
    await db.insert(schema.projectStateConflicts).values({
      repositoryId,
      unit: `plan/${randomUUID()}#title`,
      base: { v: 'base' },
      local: { v: 'ours' },
      incoming: { v: 'theirs' },
    });
    expect(await save()).toMatchObject({ committed: true, refusal: null });
  });
  it('refuses missing checkout, non-Git checkout, detached push and absent origin without committing', async () => {
    const before = await git('rev-parse', 'HEAD');
    await git('checkout', '--detach');
    expect(await save(true)).toMatchObject({ refusal: { code: 'detached_head' } });
    await git('checkout', 'main');
    expect(await save(true)).toMatchObject({ refusal: { code: 'no_origin' } });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    await rm(join(repoPath, '.git'), { recursive: true });
    expect(await save()).toMatchObject({ refusal: { code: 'not_git_checkout' } });
    await rm(repoPath, { recursive: true });
    expect(await save()).toMatchObject({ refusal: { code: 'checkout_missing' } });
  });
  it('leaves unknown files out and refuses links before committing any file', async () => {
    await save();
    const before = await git('rev-parse', 'HEAD');
    await writeFile(join(repoPath, '.haive-data/state/personal'), 'mine');
    expect(await save()).toMatchObject({
      committed: false,
      skipped: ['.haive-data/state/personal'],
    });
    expect(await git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('personal');
    await symlink('personal', join(repoPath, '.haive-data/state/link'));
    expect(await save()).toMatchObject({ committed: false, refusal: { code: 'record_refused' } });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
  });
  it.each([
    'root_claim',
    'checkout_held',
    'project_state_questions',
    'plan_merge',
    'write_pending',
    'git_operation',
  ] as const)('rechecks a late %s hold under the final locks', async (code) => {
    const original = refresh.refreshProjectStateOutcome;
    vi.spyOn(refresh, 'refreshProjectStateOutcome').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (code === 'root_claim')
        await racer
          .update(schema.repositories)
          .set({ rootClaimedAt: new Date(), rootClaimKind: 'reset' })
          .where(eq(schema.repositories.id, repositoryId));
      else if (code === 'checkout_held' || code === 'plan_merge')
        await racer.insert(schema.tasks).values({
          userId,
          repositoryId,
          type: code === 'plan_merge' ? 'plan_merge' : 'onboarding',
          title: 'late',
          status: 'running',
        });
      else if (code === 'project_state_questions') await question();
      else if (code === 'write_pending')
        await racer
          .update(schema.projectStateOutbox)
          .set({ writeIntent: {} })
          .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
      else await mkdir(join(repoPath, '.git/rebase-merge'));
      return result;
    });
    const before = await git('rev-parse', 'HEAD');
    expect(await save()).toMatchObject({ committed: false, refusal: { code } });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
  });

  it('retries a mutation between the flush and lock, with a bounded refusal under repeated mutation', async () => {
    const original = refresh.refreshProjectStateOutcome;
    let edits = 1;
    const spy = vi
      .spyOn(refresh, 'refreshProjectStateOutcome')
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        if (edits-- > 0) await markProjectStateDirty(racer, repositoryId);
        return result;
      });
    expect(await save()).toMatchObject({ committed: true, refusal: null });
    expect(spy).toHaveBeenCalledTimes(2);
    const before = await git('rev-parse', 'HEAD');
    edits = 10;
    spy.mockClear();
    expect(await save()).toMatchObject({
      committed: false,
      refusal: { code: 'projections_changing' },
    });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(await git('rev-parse', 'HEAD')).toBe(before);
  });
  it.each(['outbox', 'mirror'] as const)(
    'holds a concurrent %s revision bump through the commit',
    async (which) => {
      const atCommit = deferred();
      const release = deferred();
      const original = commits.commitHaiveProjections;
      vi.spyOn(commits, 'commitHaiveProjections').mockImplementation(async (args) => {
        atCommit.resolve();
        await release.promise;
        return original(args);
      });
      const saved = settle(save());
      await atCommit.promise;
      const table = which === 'outbox' ? schema.projectStateOutbox : schema.planMirrorState;
      const bumped = settle(
        racer
          .update(table)
          .set({ revision: sql`${table.revision} + 1` })
          .where(eq(table.repositoryId, repositoryId))
          .then(() => undefined),
      );
      let waitError: unknown = null;
      try {
        await until(async () => {
          const [row] = await db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
          );
          return (row?.n ?? 0) > 0;
        });
      } catch (err) {
        waitError = err;
      } finally {
        release.resolve();
      }
      const results = await Promise.all([saved, bumped]);
      expect(waitError).toBeNull();
      for (const result of results) expect(result.error).toBeNull();
      expect(results[0]!.value).toMatchObject({ committed: true });
    },
  );

  it('holds a concurrent writer until its complete record is committed, never a partial tree', async () => {
    const atCommit = deferred();
    const release = deferred();
    const original = commits.commitHaiveProjections;
    vi.spyOn(commits, 'commitHaiveProjections').mockImplementation(async (args) => {
      atCommit.resolve();
      await release.promise;
      return original(args);
    });
    const saved = settle(save());
    await atCommit.promise;
    const wrote = settle(
      writers.writeProjectStateColumn(racer, {
        repositoryId,
        repoPath,
        column: { ...context, projectInfo: { name: 'newer' } },
      }),
    );
    let blocked = false;
    try {
      await until(async () => {
        const [row] = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
        );
        return (row?.n ?? 0) > 0;
      });
      blocked = true;
    } finally {
      release.resolve();
    }
    const [saveResult, writeResult] = await Promise.all([saved, wrote]);
    expect(blocked).toBe(true);
    expect(saveResult.error).toBeNull();
    expect(writeResult.error).toBeNull();
    expect(saveResult.value).toMatchObject({ committed: true });
    expect(await git('show', 'HEAD:.haive-data/state/project/render.json')).toContain(
      '"name": "save"',
    );
    expect(
      await readFile(join(repoPath, '.haive-data/state/project/render.json'), 'utf8'),
    ).toContain('"name": "newer"');
    expect(await git('show', 'HEAD:.haive-data/state/format.json')).toContain('schemaVersion');
  });
  it('orders its locks against a two-pool conflict answer without a 40P01 cycle', async () => {
    // Stop Save after its flush; the resolver then owns plan-merge before asking for state.
    const flushed = deferred();
    const startSave = deferred();
    const resolverAtState = deferred();
    const continueResolver = deferred();
    const originalRefresh = refresh.refreshProjectStateOutcome;
    vi.spyOn(refresh, 'refreshProjectStateOutcome').mockImplementation(async (...args) => {
      const result = await originalRefresh(...args);
      flushed.resolve();
      await startSave.promise;
      return result;
    });
    const saved = settle(save());
    await flushed.promise;
    const row = await question();
    const originalStateLock = writers.lockProjectState;
    let first = true;
    vi.spyOn(writers, 'lockProjectState').mockImplementation(async (tx, id) => {
      if (first) {
        first = false;
        resolverAtState.resolve();
        await continueResolver.promise;
      }
      await originalStateLock(tx, id);
    });
    const originalMergeLock = planLocks.lockPlanMerge;
    let savePid = 0;
    vi.spyOn(planLocks, 'lockPlanMerge').mockImplementation(async (tx, id) => {
      const [backend] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as {
        pid: number;
      }[];
      savePid = backend!.pid;
      await originalMergeLock(tx, id);
    });
    const answered = settle(
      resolveProjectStateConflict(racer, {
        repositoryId,
        userId,
        conflictId: row.id,
        answer: 'keep_mine',
      }),
    );
    await resolverAtState.promise;
    savePid = 0;
    startSave.resolve();
    try {
      await until(async () => {
        if (!savePid) return false;
        const [wait] = await racer.execute<{ waiting: boolean }>(
          sql`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${savePid}`,
        );
        return wait?.waiting === true;
      });
    } finally {
      continueResolver.resolve();
    }
    const results = await Promise.all([saved, answered]);
    for (const result of results) {
      expect(hasPgCode(result.error, '40P01')).toBe(false);
      expect(result.error).toBeNull();
    }
    expect(results[0]!.value).toMatchObject({ committed: true });
    expect(results[1]!.value).toMatchObject({ kind: 'resolved' });
  }, 30_000);
});
