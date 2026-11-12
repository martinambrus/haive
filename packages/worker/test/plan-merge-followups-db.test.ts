import { failGit, type FakeGit } from './support/fake-git.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { lockPlanMerge } from '@haive/shared/plan';
import { discardPlanMerge } from '../src/step-engine/steps/plan/01-plan-merge.js';
import { ensurePlanMergeWorktree, mergeOriginInto } from '../src/plan/merge.js';
import { planMergeFixBaseline } from '../src/plan/merge-baseline.js';
import * as merge from '../src/plan/merge.js';
import { integrateOrigin } from '../src/queues/plan-mirror-queue.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

const url = process.env.PLAN_MERGE_FOLLOWUPS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_merge_followups_test'))
  throw new Error('Use a dedicated plan_merge_followups_test database');
const fixture = url ? await import('./support/git-http.js') : null;
const identity = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', fixture!.networkGitArgs(args), {
    cwd,
    env: { ...process.env, ...identity },
    encoding: 'utf8',
  }).trim();

describe.skipIf(!url)('plan merge transaction handles on real Postgres', () => {
  let db: Database;
  let shim: FakeGit | null = null;
  let root: string;
  let repoPath: string;
  let worktreePath: string;
  let userId: string;
  let repositoryId: string;
  let taskId: string;
  beforeAll(() => {
    // A pool query blocked by the outer transaction fails promptly instead of hanging the suite.
    const bounded = new URL(url!);
    bounded.searchParams.set('options', '-c statement_timeout=1000');
    db = createDatabase(bounded.toString());
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    root = await mkdtemp(path.join(fixture!.fixtureBase, 'plan-merge-followups-'));
    const origin = path.join(root, 'origin');
    repoPath = path.join(root, 'local');
    git(root, 'init', '-q', '-b', 'main', origin);
    await writeFile(path.join(origin, 'conflict.txt'), 'base\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'base');
    git(root, 'clone', '-q', fixture!.httpOrigin(origin), repoPath);
    await writeFile(path.join(origin, 'conflict.txt'), 'theirs\n');
    git(origin, 'commit', '-qam', 'theirs');
    await writeFile(path.join(repoPath, 'conflict.txt'), 'ours\n');
    git(repoPath, 'commit', '-qam', 'ours');
    git(repoPath, 'fetch', '-q', 'origin');
    worktreePath = await ensurePlanMergeWorktree(repoPath);
    await mergeOriginInto(worktreePath, 'main', false, identity);
    userId = randomUUID();
    repositoryId = randomUUID();
    taskId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
      role: 'admin', // The dedicated fixture may fetch its loopback HTTP origin.
    });
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'merge followups',
      source: 'blank',
      status: 'ready',
      storagePath: repoPath,
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      userId,
      repositoryId,
      type: 'plan_merge',
      title: 'merge',
      status: 'cancelled',
    });
  });
  afterEach(async () => {
    await shim?.restore();
    shim = null;
    vi.restoreAllMocks();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(root, { recursive: true, force: true });
  });
  const events = (eventType: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, eventType)));

  it('writes the skip event through the transaction that holds the cancelled task row', async () => {
    const otherTaskId = randomUUID();
    await db.insert(schema.tasks).values({
      id: otherTaskId,
      userId,
      repositoryId,
      type: 'plan_merge',
      title: 'merge',
      status: 'running',
    });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((fn) =>
      transaction(async (tx) => {
        await tx.execute(sql`select id from tasks where id = ${taskId} for update`);
        return fn(tx);
      }),
    );
    await discardPlanMerge(db, taskId);
    expect(await events('plan_merge.discard_skipped')).toMatchObject([
      { payload: { otherTaskId } },
    ]);
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain(worktreePath);
  });

  it('reads a baseline written in the same transaction before discarding fixer changes', async () => {
    const taskStepId = randomUUID();
    await db
      .insert(schema.taskSteps)
      .values({ id: taskStepId, taskId, stepId: '01-plan-merge', stepIndex: 0, title: 'merge' });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((fn) =>
      transaction(async (tx) => {
        const recorded = await planMergeFixBaseline(
          tx,
          {
            repositoryId,
            taskId,
            taskStepId,
            worktreePath,
          },
          true,
        );
        expect(recorded.baseline).toHaveProperty('tree');
        await writeFile(path.join(worktreePath, 'extra.txt'), 'fixer work\n');
        return fn(tx);
      }),
    );
    await discardPlanMerge(db, taskId);
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string; moved: string[] };
    expect(payload.moved).toContain('extra.txt');
    expect(await readFile(path.join(repoPath, payload.folder, 'files/extra.txt'), 'utf8')).toBe(
      'fixer work\n',
    );
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).not.toContain(worktreePath);
  });
  it('keeps the report when Git fails after the leftovers were moved', async () => {
    const taskStepId = randomUUID();
    await db.insert(schema.taskSteps).values({
      id: taskStepId,
      taskId,
      stepId: '01-plan-merge',
      stepIndex: 0,
      title: 'merge',
    });
    await planMergeFixBaseline(db, { repositoryId, taskId, taskStepId, worktreePath }, true);
    await writeFile(path.join(worktreePath, 'extra.txt'), 'fixer work\n');
    shim = await failGit(['worktree', 'list']);
    await discardPlanMerge(db, taskId);
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string };
    expect(await readFile(path.join(repoPath, payload.folder, 'reported'), 'utf8')).toBe('');
    expect(await events('plan_merge.discard_failed')).toHaveLength(1);
  });

  it('commits the leftovers report before recording a discard refusal and keeps the worktree', async () => {
    const taskStepId = randomUUID();
    await db.insert(schema.taskSteps).values({
      id: taskStepId,
      taskId,
      stepId: '01-plan-merge',
      stepIndex: 0,
      title: 'merge',
    });
    await planMergeFixBaseline(db, { repositoryId, taskId, taskStepId, worktreePath }, true);
    await writeFile(path.join(worktreePath, 'extra.txt'), 'staged fixer work\n');
    git(worktreePath, 'add', 'extra.txt');
    shim = await failGit(['restore', '--staged']);
    await discardPlanMerge(db, taskId);
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string };
    expect(await readFile(path.join(repoPath, payload.folder, 'reported'), 'utf8')).toBe('');
    expect(await events('plan_merge.discard_failed')).toHaveLength(1);
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain(worktreePath);
  });
  it('reports a real staged fixer change before an index refusal, without removing the worktree', async () => {
    const taskStepId = randomUUID();
    await db.insert(schema.taskSteps).values({
      id: taskStepId,
      taskId,
      stepId: '01-plan-merge',
      stepIndex: 0,
      title: 'merge',
    });
    await planMergeFixBaseline(db, { repositoryId, taskId, taskStepId, worktreePath }, true);
    await writeFile(path.join(worktreePath, 'extra.txt'), 'staged fixer work\n');
    git(worktreePath, 'add', 'extra.txt');
    await writeFile(git(worktreePath, 'rev-parse', '--git-path', 'index.lock'), 'held');
    const remove = vi.spyOn(merge, 'removePlanMergeWorktree');
    await expect(
      integrateOrigin({
        repositoryId,
        repoPath,
        branch: 'main',
        userId,
        identity,
        kept: new Map(),
      }),
    ).rejects.toThrow('A merge fixer staged changes');
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string; leftCount: number };
    expect(payload.leftCount).toBeGreaterThan(0);
    expect(await readFile(path.join(repoPath, payload.folder, 'reported'), 'utf8')).toBe('');
    expect(await readFile(path.join(repoPath, payload.folder, 'files/extra.txt'), 'utf8')).toBe(
      'staged fixer work\n',
    );
    expect(remove).not.toHaveBeenCalled();
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain(worktreePath);
    expect(git(worktreePath, 'rev-parse', 'MERGE_HEAD')).not.toBe('');
  });
  it('keeps the committed leftovers report when the merge transaction fails in Postgres', async () => {
    const taskStepId = randomUUID();
    await db.insert(schema.taskSteps).values({
      id: taskStepId,
      taskId,
      stepId: '01-plan-merge',
      stepIndex: 0,
      title: 'merge',
    });
    await planMergeFixBaseline(db, { repositoryId, taskId, taskStepId, worktreePath }, true);
    await writeFile(path.join(worktreePath, 'extra.txt'), 'fixer work\n');
    const transaction = db.transaction.bind(db);
    let calls = 0;
    vi.spyOn(db, 'transaction').mockImplementation((fn) =>
      transaction(async (tx) => {
        calls++;
        if (calls === 2) {
          await tx.insert(schema.taskEvents).values({ taskId, eventType: 'test.merge_rollback' });
          // A real SQL failure aborts the merge transaction and rolls its own event back.
          await tx.execute(sql`select 1 / 0`);
        }
        return fn(tx);
      }),
    );
    await expect(
      integrateOrigin({
        repositoryId,
        repoPath,
        branch: 'main',
        userId,
        identity,
        kept: new Map(),
      }),
    ).rejects.toMatchObject({ cause: { code: '22012' } });
    expect(calls).toBe(2);
    expect(await events('test.merge_rollback')).toEqual([]);
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string; moved: string[] };
    expect(payload.moved).toContain('extra.txt');
    expect(await readFile(path.join(repoPath, payload.folder, 'reported'), 'utf8')).toBe('');
    expect(await readFile(path.join(repoPath, payload.folder, 'files/extra.txt'), 'utf8')).toBe(
      'fixer work\n',
    );
  });

  it('refuses a conversation opened between the transactions while keeping the first report', async () => {
    const taskStepId = randomUUID();
    await db.insert(schema.taskSteps).values({
      id: taskStepId,
      taskId,
      stepId: '01-plan-merge',
      stepIndex: 0,
      title: 'merge',
    });
    await planMergeFixBaseline(db, { repositoryId, taskId, taskStepId, worktreePath }, true);
    await writeFile(path.join(worktreePath, 'extra.txt'), 'fixer work\n');
    const otherTaskId = randomUUID();
    const transaction = db.transaction.bind(db);
    let calls = 0;
    vi.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const result = await transaction(fn);
      if (++calls === 1) {
        // The opener uses the same lock, after the report commits and before the merge takes it.
        await transaction(async (tx) => {
          await lockPlanMerge(tx, repositoryId);
          await tx.insert(schema.tasks).values({
            id: otherTaskId,
            userId,
            repositoryId,
            type: 'plan_merge',
            title: 'new merge',
            status: 'running',
          });
        });
      }
      return result;
    });
    const remove = vi.spyOn(merge, 'removePlanMergeWorktree');
    await expect(
      integrateOrigin({
        repositoryId,
        repoPath,
        branch: 'main',
        userId,
        identity,
        kept: new Map(),
      }),
    ).rejects.toMatchObject({ refusal: { code: 'plan_merge', taskId: otherTaskId } });
    const reports = await events('merge.fixer_leftovers');
    expect(reports).toHaveLength(1);
    const payload = reports[0]!.payload as { folder: string };
    expect(await readFile(path.join(repoPath, payload.folder, 'reported'), 'utf8')).toBe('');
    expect(remove).not.toHaveBeenCalled();
    expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain(worktreePath);
  });
});
