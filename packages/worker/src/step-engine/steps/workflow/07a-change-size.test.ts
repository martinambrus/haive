import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { measureImplementationSize, recordChangeSize } from './_change-size.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { codeSimplifyStep } from './07a-code-simplify.js';
import type { StepContext } from '../../step-definition.js';
import { gitExec } from '../../../repo/git-exec.js';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: async (_db: unknown, _task: string, step: string) =>
    step === '01-worktree-setup'
      ? {
          output: {
            worktreePath: state.root,
            sandboxWorktreePath: '/workspace',
            baseBranch: 'main',
          },
        }
      : step === '07-phase-2-implement'
        ? { output: { filesTouched: ['a.py', 'tests/a.py'] } }
        : null,
}));
vi.mock('./_spec-artifact.js', () => ({
  resolveSpecView: async () => ({ text: 'Keep behavior' }),
  hydrateNoSpecBrief: async () => {},
}));
const dialect = new PgDialect();
function context() {
  const events = new Map<string, { id: string; payload: Record<string, unknown> }>();
  const db = {
    query: {
      taskEvents: {
        findFirst: async ({ where }: any) =>
          events.get(dialect.sqlToQuery(where).params[0] as string),
      },
    },
    insert: () => ({
      values: (row: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (events.has(row.id)) return [];
            events.set(row.id, structuredClone(row));
            return [row];
          },
        }),
      }),
    }),
  };
  return {
    events,
    ctx: {
      taskId: 'task',
      taskStepId: 'step',
      round: 0,
      rerunGeneration: 0,
      repoPath: repositoryRoot,
      workspacePath: state.root,
      sandboxWorkdir: '/workspace',
      db,
      signal: new AbortController().signal,
      throwIfCancelled() {},
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as StepContext,
  };
}
let root: string;
let repositoryRoot: string;
beforeAll(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), 'change-size-'));
  root = repositoryRoot;
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'a.py'), 'x = 0\n');
  await writeFile(join(root, 'tests/a.py'), 'x = 0\n');
  await gitExec(['init', '-b', 'main'], { cwd: root });
  await gitExec(['add', '.'], { cwd: root });
  await gitExec(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'],
    { cwd: root },
  );
  root = join(repositoryRoot, '.haive/worktrees/task');
  await gitExec(['worktree', 'add', '-b', 'work', root], { cwd: repositoryRoot });
  state.root = root;
});
afterAll(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe('simplifier change sizes on the integration tree', () => {
  it('persists all three sizes, freezes before and is idempotent when either apply is replayed', async () => {
    const { ctx, events } = context();
    await writeFile(join(root, 'a.py'), 'x = 0\ny = 1\nz = 2\n');
    await writeFile(join(root, 'tests/a.py'), 'test_changed = 99\n');
    const detected = await codeSimplifyStep.detect!(ctx);
    await writeFile(join(root, 'a.py'), 'x = 0\ny = 1\n');
    const args = {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
      llmInvocationId: 'simplify',
      llmOutput: { files_simplified: ['a.py'], changes_made: ['simplified'] },
    };
    const simplify = await codeSimplifyStep.apply(ctx, args);
    expect(simplify.changeSize.before).toMatchObject({
      state: 'measured',
      result: { total: { net: 6 } },
    });
    expect(simplify.changeSize.afterSimplify.result?.total.net).toBe(3);
    expect(simplify.changeSize.afterSimplify.result?.excluded).toContain('tests/a.py');
    const redetected = await codeSimplifyStep.detect!(ctx);
    expect(redetected.changeSizeBefore).toEqual(detected.changeSizeBefore);
    expect(await codeSimplifyStep.apply(ctx, args)).toEqual(simplify);
    await writeFile(join(root, 'a.py'), 'x = 0\ny = 1\nz = 2\n');
    const fixArgs = {
      ...args,
      iteration: 1,
      llmInvocationId: 'fix',
      llmOutput: { fixes_needed: true, fixes_made: ['restored'] },
      previousIterations: [
        { iteration: 0, applyOutput: simplify, llmOutput: args.llmOutput, continueRequested: true },
      ],
    };
    const fixed = await codeSimplifyStep.apply(ctx, fixArgs);
    expect(fixed.changeSize.before.result?.total.net).toBe(6);
    expect(fixed.changeSize.afterSimplify.result?.total.net).toBe(3);
    expect(fixed.changeSize.afterFixup.result?.total.net).toBe(6);
    await writeFile(join(root, 'a.py'), 'changed_after_capture = 8\n');
    expect(await codeSimplifyStep.apply(ctx, fixArgs)).toEqual(fixed);
    expect(events.size).toBe(3);
    expect([...events.values()].every((e) => e.payload.version === 1)).toBe(true);
  });
  it('keeps the step outcome when measurement or its persistence fails, with explicitly unknown sizes', async () => {
    const { ctx } = context();
    ctx.db = {
      query: {
        taskEvents: {
          findFirst: async () => {
            throw new Error('unavailable');
          },
        },
      },
    } as any;
    const output = await codeSimplifyStep.apply(ctx, {
      detected: {
        worktreePath: '/missing',
        sandboxWorktreePath: '/workspace',
        spec: '',
        implementationFiles: { files: ['a.py'], total: 1, truncated: false, scanError: null },
        dagExecution: null,
      },
      formValues: {},
      iteration: 0,
      previousIterations: [],
      llmInvocationId: 'failed',
      llmOutput: { files_simplified: ['a.py'], changes_made: ['simplified'] },
    });
    expect(output).toMatchObject({
      ran: true,
      source: 'simplifier',
      filesSimplified: ['a.py'],
      changesMade: ['simplified'],
      noChangesNeeded: false,
      fixesNeeded: false,
      fixesMade: [],
    });
    expect(output.changeSize.before.state).toBe('unknown');
    expect(output.changeSize.afterSimplify.state).toBe('unknown');
    expect(
      codeSimplifyStep.loop!.shouldContinue({ applyOutput: output, iteration: 0 } as any),
    ).toBe(true);
  });
});

it('retains an unknown capture, rather than changing the step outcome or substituting a later image', async () => {
  const { ctx, events } = context();
  const args = {
    detected: {
      worktreePath: join(repositoryRoot, 'missing'),
      sandboxWorktreePath: '/workspace',
      spec: '',
      implementationFiles: { files: ['a.py'], total: 1, truncated: false, scanError: null },
      dagExecution: null,
    },
    formValues: {},
    iteration: 0,
    previousIterations: [],
    llmInvocationId: 'missing',
    llmOutput: { files_simplified: [], no_changes_needed: true },
  };
  const output = await codeSimplifyStep.apply(ctx, args);
  expect(output).toMatchObject({
    ran: true,
    noChangesNeeded: true,
    source: 'simplifier',
    changeSize: { afterSimplify: { state: 'unknown' } },
  });
  expect(events.size).toBe(1);
  expect(
    await codeSimplifyStep.apply(ctx, {
      ...args,
      detected: { ...args.detected, worktreePath: root },
    }),
  ).toEqual(output);
});

it('keeps reset generations and invocations separate, including simultaneous apply replays', async () => {
  const { ctx, events } = context();
  const before = await recordChangeSize(ctx, root, 'before', null, -1);
  const captures = await Promise.all([
    recordChangeSize(ctx, root, 'afterSimplify', 'concurrent', 0, before),
    recordChangeSize(ctx, root, 'afterSimplify', 'concurrent', 0, before),
  ]);
  expect(captures[0]).toEqual(captures[1]);
  expect(events.size).toBe(2);
  await recordChangeSize(ctx, root, 'afterSimplify', 'new-invocation', 0, before);
  ctx.rerunGeneration = 1;
  const reset = await recordChangeSize(ctx, root, 'before', null, -1);
  expect(reset.eventId).not.toBe(before.eventId);
  expect(events.size).toBe(4);
});

it('reads unreported untracked additions, committed changes and removals, and refuses a symlink', async () => {
  const { ctx } = context();
  await writeFile(join(root, 'unreported.py'), 'x=1\n');
  await gitExec(['add', 'unreported.py'], { cwd: root });
  await gitExec(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'change'],
    { cwd: root },
  );
  await writeFile(join(root, 'new.py'), 'x=1\n');
  await rm(join(root, 'a.py'));
  const measured = await measureImplementationSize(ctx, root);
  expect(measured.state).toBe('measured');
  expect(measured.result?.files.find((f) => f.path === 'unreported.py')?.size?.net).toBe(3);
  expect(measured.result?.files.find((f) => f.path === 'new.py')?.size?.net).toBe(3);
  expect(measured.result?.files.find((f) => f.path === 'a.py')?.size?.net).toBe(-3);
  await symlink(join(repositoryRoot, 'a.py'), join(root, 'escape.py'));
  const refused = await measureImplementationSize(ctx, root);
  expect(refused.result?.files.find((f) => f.path === 'escape.py')?.size).toBeNull();
});

it('makes an over-budget capture explicitly unknown at a small injectable host limit', async () => {
  const { ctx } = context();
  expect(await measureImplementationSize(ctx, root, undefined, { totalBytes: 1 })).toMatchObject({
    state: 'unknown',
    reason: 'Change exceeds the measurement byte budget.',
  });
});
