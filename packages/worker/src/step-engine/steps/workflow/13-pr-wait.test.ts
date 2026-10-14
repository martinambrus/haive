import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import type { StepContext } from '../../step-definition.js';
import { StepSupersededError } from '../../step-ownership.js';
import { prWaitStep } from './13-pr-wait.js';

describe('finalization RAG review', () => {
  function setup() {
    const taskId = randomUUID();
    const queryId = randomUUID();
    const fake = createFakeDb({
      tasks: schema.tasks,
      ragQueryLog: schema.ragQueryLog,
      taskSteps: schema.taskSteps,
      cliInvocations: schema.cliInvocations,
    });
    fake.insert(schema.tasks, {
      id: taskId,
      userId: randomUUID(),
      type: 'workflow',
      title: 'Fixture',
    });
    fake.insert(schema.ragQueryLog, {
      id: queryId,
      taskId,
      query: 'cookies',
      hitCount: 0,
      resultHits: [],
    });
    const taskStepId = randomUUID();
    fake.insert(schema.taskSteps, {
      id: taskStepId,
      taskId,
      stepId: '13-pr-wait',
      stepIndex: 15,
      title: 'Pull request',
      status: 'running',
    });
    const ctx = {
      taskId,
      taskStepId,
      db: fake.db,
      throwIfCancelled: vi.fn(),
      logger: { warn: vi.fn() },
    } as unknown as StepContext;
    const detected = {
      pending: false,
      prUrl: null,
      prProvider: null,
      finalizeMode: null,
      worktreePath: null,
      branchName: null,
      ragUsage: {
        queries: [
          {
            id: queryId,
            query: 'cookies',
            hitCount: 0,
            createdAt: new Date().toISOString(),
            hits: [],
          },
        ],
        runs: [],
      },
    };
    return { fake, ctx, detected };
  }
  it('assesses zero-hit queries on the path without a PR or a model call', async () => {
    const { fake, ctx, detected } = setup();
    expect(prWaitStep.llm!.skipIf!({ detected, formValues: {} })).toBe(true);
    await prWaitStep.apply!(ctx, {
      detected,
      formValues: {},
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    });
    expect(fake.rows(schema.ragQueryLog)[0]!.usageAssessment).toMatchObject({
      status: 'unused',
      reason: 'No results were returned.',
    });
  });
  it('continues finalization if saving the review fails', async () => {
    const { ctx, detected } = setup();
    ctx.db = {
      update: () => {
        throw new Error('store unavailable');
      },
    } as unknown as StepContext['db'];
    await expect(
      prWaitStep.apply!(ctx, {
        detected,
        formValues: {},
        llmOutput: null,
        iteration: 0,
        previousIterations: [],
      }),
    ).resolves.toMatchObject({ finalized: false, removed: false });
    expect(ctx.logger.warn).toHaveBeenCalled();
    expect(prWaitStep.llm!.optional).toBe(true);
  });
  it('marks omitted queries neutral and zero-hit queries unused without touching another task', async () => {
    const { fake, ctx, detected } = setup();
    const omitted = fake.insert(schema.ragQueryLog, {
      id: randomUUID(),
      taskId: ctx.taskId,
      query: 'omitted from the evidence budget',
      hitCount: 8,
    });
    const foreignTask = randomUUID();
    fake.insert(schema.tasks, {
      id: foreignTask,
      userId: randomUUID(),
      type: 'workflow',
      title: 'Other task',
    });
    const foreign = fake.insert(schema.ragQueryLog, {
      id: randomUUID(),
      taskId: foreignTask,
      query: 'other user query',
      hitCount: 1,
    });
    await prWaitStep.apply!(ctx, {
      detected: { ...detected, ragUsage: { queries: [], runs: [] } },
      formValues: {},
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    });
    const rows = fake.rows(schema.ragQueryLog);
    expect(rows.find((row) => row.id === omitted.id)!.usageAssessment).toMatchObject({
      status: 'unknown',
    });
    expect(rows.find((row) => row.id === foreign.id)!.usageAssessment).toBeNull();
    expect(rows[0]!.usageAssessment).toMatchObject({ status: 'unused' });
  });
  it('does not skip a reopened PR’s fresh evidence or legacy detect payloads', () => {
    const { detected } = setup();
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, pending: true }, formValues: {} }),
    ).toBe(false);
    expect(
      prWaitStep.llm!.skipIf!({ detected: { ...detected, ragUsage: undefined }, formValues: {} }),
    ).toBe(false);
  });
  it.each(['no queries', 'zero hits', 'uncaptured results'])(
    'skips dispatch after refreshing a PR with %s',
    async (scenario) => {
      const { fake, ctx, detected } = setup();
      if (scenario === 'no queries') {
        await fake.db.delete(schema.ragQueryLog).where(eq(schema.ragQueryLog.taskId, ctx.taskId));
      } else if (scenario === 'uncaptured results') {
        await fake.db
          .update(schema.ragQueryLog)
          .set({ hitCount: 2, resultHits: null })
          .where(eq(schema.ragQueryLog.taskId, ctx.taskId));
      }
      detected.pending = true;
      expect(prWaitStep.llm!.skipIf!({ detected, formValues: {} })).toBe(false);
      expect(await prWaitStep.llm!.prepare!({ ctx, detected, formValues: {} })).toBe(false);
      expect(detected.ragUsage.queries).toEqual([]);
    },
  );
  it.each(['pending', 'skipped', 'failed'] as const)(
    'does not restore cleared detect output when the step becomes %s during evidence loading',
    async (status) => {
      const { fake, ctx, detected } = setup();
      const findQueries = fake.db.query.ragQueryLog.findMany.bind(fake.db.query.ragQueryLog);
      vi.spyOn(fake.db.query.ragQueryLog, 'findMany').mockImplementationOnce(async (...args) => {
        const queries = await findQueries(...args);
        await fake.db
          .update(schema.taskSteps)
          .set({ status, detectOutput: null })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        return queries;
      });
      await expect(
        prWaitStep.llm!.prepare!({ ctx, detected, formValues: {} }),
      ).rejects.toBeInstanceOf(StepSupersededError);
      const row = await fake.db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, ctx.taskStepId),
      });
      expect(row).toMatchObject({ status, detectOutput: null });
    },
  );
  it('allows dispatch when reopening added captured hits and timestamped agent prose', async () => {
    const { fake, ctx, detected } = setup();
    const at = new Date();
    await fake.db
      .update(schema.ragQueryLog)
      .set({
        hitCount: 1,
        createdAt: at,
        resultHits: [{ sourcePath: 'src/session.ts', content: 'Cookie implementation' }],
      })
      .where(eq(schema.ragQueryLog.taskId, ctx.taskId));
    const originalStep = randomUUID();
    fake.insert(schema.taskSteps, {
      id: originalStep,
      taskId: ctx.taskId,
      stepId: '07-phase-2-implement',
      stepIndex: 7,
      title: 'Implement',
      status: 'done',
    });
    fake.insert(schema.cliInvocations, {
      id: randomUUID(),
      taskId: ctx.taskId,
      taskStepId: originalStep,
      mode: 'cli',
      prompt: 'Fixture',
      startedAt: new Date(at.getTime() - 1000),
      endedAt: new Date(at.getTime() + 1000),
      cleanTranscript: {
        segments: [
          {
            kind: 'model',
            at: at.getTime() + 500,
            text: 'I used src/session.ts to implement secure cookies.',
          },
        ],
      },
    });
    detected.pending = true;
    expect(await prWaitStep.llm!.prepare!({ ctx, detected, formValues: {} })).toBeUndefined();
    expect(detected.ragUsage.queries).toHaveLength(1);
    expect(detected.ragUsage.runs).toHaveLength(1);
  });
});

describe('finalize: the worktree (real git)', () => {
  const exec = promisify(execFile);
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@haive.local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@haive.local',
  };
  async function git(dir: string, args: string[]): Promise<void> {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
  }
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  /** A parent repo on `main` and a `feature/x` worktree at .haive/worktrees/feature-x, as 01-worktree-setup lays it out. */
  async function setupWorktree(): Promise<{ parent: string; wt: string }> {
    const parent = await mkdtemp(path.join(tmpdir(), 'pr-wait-'));
    await git(parent, ['init', '-b', 'main']);
    await git(parent, ['config', 'gc.auto', '0']);
    await writeFile(path.join(parent, 'base.txt'), 'base\n', 'utf8');
    await git(parent, ['add', '-A']);
    await git(parent, ['commit', '-m', 'initial']);
    const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
    await mkdir(path.dirname(wt), { recursive: true });
    await git(parent, ['worktree', 'add', '-b', 'feature/x', wt, 'main']);
    return { parent, wt };
  }

  /** Two changes no commit holds: an edited tracked file and an untracked one, its name with a space. */
  async function leaveUncommitted(wt: string): Promise<void> {
    await writeFile(path.join(wt, 'base.txt'), 'base, edited\n', 'utf8');
    await writeFile(path.join(wt, 'learning notes.md'), 'not committed\n', 'utf8');
  }

  function finalizeCtx(parent: string): StepContext {
    return {
      taskId: randomUUID(),
      taskStepId: randomUUID(),
      repoPath: parent,
      db: createFakeDb({ ragQueryLog: schema.ragQueryLog }).db,
      throwIfCancelled: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as StepContext;
  }

  const finalize = (ctx: StepContext, worktreePath: string) =>
    prWaitStep.apply!(ctx, {
      detected: {
        pending: true,
        prUrl: 'https://example.test/pr/1',
        prProvider: 'github',
        finalizeMode: 'auto',
        worktreePath,
        branchName: 'feature/x',
        ragUsage: { queries: [], runs: [] },
      },
      formValues: {},
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    });

  it('keeps a worktree that holds uncommitted work, and says how much', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await leaveUncommitted(wt);
      const ctx = finalizeCtx(parent);
      const out = await finalize(ctx, wt);
      expect(out).toMatchObject({ finalized: true, removed: false });
      expect(out.message).toContain(`worktree kept at ${wt}`);
      expect(out.message).toContain('2 uncommitted changes');
      expect(await readFile(path.join(wt, 'base.txt'), 'utf8')).toBe('base, edited\n');
      expect(await readFile(path.join(wt, 'learning notes.md'), 'utf8')).toBe('not committed\n');
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: wt, uncommitted: 2 }),
        expect.any(String),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('removes a clean worktree and keeps its branch, as it always did', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      const out = await finalize(finalizeCtx(parent), wt);
      expect(out).toEqual({
        finalized: true,
        removed: true,
        message: `finalized: removed worktree ${wt}`,
      });
      expect(await exists(wt)).toBe(false);
      await expect(
        git(parent, ['rev-parse', '--verify', 'refs/heads/feature/x']),
      ).resolves.toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps a worktree git cannot read, which is not the same as a clean one', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await writeFile(path.join(wt, '.git'), 'gitdir: /nonexistent/haive-gitdir\n', 'utf8');
      const ctx = finalizeCtx(parent);
      const out = await finalize(ctx, wt);
      expect(out).toMatchObject({ finalized: true, removed: false });
      expect(out.message).toContain(`worktree kept at ${wt}`);
      expect(out.message).toContain('could not be checked for uncommitted changes');
      expect(await exists(wt)).toBe(true);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: wt, uncommitted: null }),
        expect.any(String),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('finalizes a worktree that is already gone as removed, as before', async () => {
    const { parent, wt } = await setupWorktree();
    try {
      await git(parent, ['worktree', 'remove', '--force', wt]);
      const out = await finalize(finalizeCtx(parent), wt);
      expect(out).toMatchObject({ finalized: true, removed: true });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
