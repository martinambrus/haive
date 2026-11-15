import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { openDirNoFollow } from '@haive/shared/fs-safe';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import { createStepHostServices } from '../src/step-engine/step-host-services.js';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { gitExec } from '../src/repo/git-exec.js';
vi.mock('../src/repo/git-exec.js', () => ({ gitExec: vi.fn(), gitRun: vi.fn() }));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(),
}));
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', () => ({
  collectImplementationFiles: vi.fn(),
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  openDirNoFollow: vi.fn(async () => ({ close: vi.fn() })),
}));
const task = vi.fn();
const step = vi.fn();
let controller = new AbortController();
const ctx: StepContext = {
  taskId: 'task',
  taskStepId: 'step',
  userId: 'user',
  round: 2,
  repoPath: '/repo',
  workspacePath: '/repo',
  sandboxWorkdir: '/workspace',
  cliProviderId: null,
  signal: controller.signal,
  db: {
    query: { tasks: { findFirst: task }, taskSteps: { findFirst: step } },
  } as unknown as Database,
  logger: logger.child({ test: 'host' }),
  async emitProgress() {},
  throwIfCancelled() {
    if (controller.signal.aborted) throw new TaskCancelledError();
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  controller = new AbortController();
  ctx.signal = controller.signal;
  task.mockResolvedValue({
    id: 'task',
    userId: 'user',
    currentRound: 2,
    worktreePath: '/repo/.haive/worktrees/task',
  });
  step.mockResolvedValue({ taskId: 'task', round: 2 });
  vi.mocked(loadPreviousStepOutput).mockResolvedValue({
    id: 'row',
    stepId: '01-worktree-setup',
    status: 'done',
    round: 0,
    detect: null,
    output: { worktreePath: '/repo/.haive/worktrees/task' },
    iterations: [],
  });
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    files: ['a'],
    total: 1,
    truncated: false,
    scanError: null,
  });
});
afterEach(() => vi.useRealTimers());
it('adapts the existing previous-output helper with the captured round bound', async () => {
  const host = createStepHostServices(ctx);
  expect(await host.loadPreviousStepOutput('previous')).toEqual({
    detect: null,
    output: { worktreePath: '/repo/.haive/worktrees/task' },
    iterations: [],
  });
  expect(loadPreviousStepOutput).toHaveBeenCalledWith(ctx.db, 'task', 'previous', 2);
});
it.each([
  ['task', () => task.mockResolvedValue({ userId: 'other', currentRound: 2 })],
  ['round', () => step.mockResolvedValue({ taskId: 'task', round: 3 })],
] as const)('refuses %s binding mismatches', async (_name, setup) => {
  setup();
  await expect(
    createStepHostServices(ctx).loadPreviousStepOutput('previous'),
  ).rejects.toMatchObject({ name: 'StepHostBindingError' });
  expect(loadPreviousStepOutput).not.toHaveBeenCalled();
});
it('refuses arbitrary paths before collecting and adapts the actual collector', async () => {
  const host = createStepHostServices(ctx);
  await expect(host.collectImplementationFiles('/elsewhere')).rejects.toMatchObject({
    name: 'StepHostBindingError',
  });
  expect(collectImplementationFiles).not.toHaveBeenCalled();
  await host.collectImplementationFiles('/repo/.haive/worktrees/task');
  expect(collectImplementationFiles).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'task', round: 2 }),
    '/repo/.haive/worktrees/task',
    expect.objectContaining({ maxRound: 2, signal: ctx.signal }),
  );
});
it('captures context identity and refuses a worktree retarget after the first call', async () => {
  const mutable = { ...ctx };
  const host = createStepHostServices(mutable);
  mutable.taskId = 'other-task';
  mutable.userId = 'other-user';
  mutable.round = 99;
  await host.collectImplementationFiles('/repo/.haive/worktrees/task');
  task.mockResolvedValue({
    id: 'task',
    userId: 'user',
    currentRound: 2,
    worktreePath: '/repo/other',
  });
  await expect(host.collectImplementationFiles('/repo/other')).rejects.toMatchObject({
    name: 'StepHostBindingError',
  });
});
it('refuses a foreign task step and a future context round', async () => {
  step.mockResolvedValue({ taskId: 'other-task', round: 2 });
  await expect(
    createStepHostServices(ctx).loadPreviousStepOutput('previous'),
  ).rejects.toMatchObject({ name: 'StepHostBindingError' });
  step.mockResolvedValue({ taskId: 'task', round: 2 });
  task.mockResolvedValue({ id: 'task', userId: 'user', currentRound: 1, worktreePath: '/repo' });
  await expect(
    createStepHostServices(ctx).loadPreviousStepOutput('previous'),
  ).rejects.toMatchObject({ name: 'StepHostBindingError' });
  await expect(
    createStepHostServices(ctx).readReviewDiff({ worktreePath: '/elsewhere', maxBytes: 1000 }),
  ).rejects.toMatchObject({ name: 'StepHostBindingError' });
});
it('normalizes cancellation during an awaited read, using fake time', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreviousStepOutput).mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  );
  const promise = createStepHostServices(ctx).loadPreviousStepOutput('previous');
  const rejected = expect(promise).rejects.toBeInstanceOf(TaskCancelledError);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(100);
});

vi.mock('../src/queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: vi.fn() }));

it.each(['EMFILE', 'ENFILE'])('preserves %s during worktree binding', async (code) => {
  const error = Object.assign(new Error(code), { code });
  vi.mocked(openDirNoFollow).mockRejectedValueOnce(error);
  await expect(
    createStepHostServices(ctx).collectImplementationFiles('/repo/.haive/worktrees/task'),
  ).rejects.toBe(error);
});
it('normalizes filesystem errors during binding without exposing host paths', async () => {
  vi.mocked(openDirNoFollow).mockRejectedValueOnce(new Error('Cannot open /host/private/tree'));
  await expect(
    createStepHostServices(ctx).collectImplementationFiles('/repo/.haive/worktrees/task'),
  ).rejects.toMatchObject({
    name: 'StepHostBindingError',
    message: 'Context worktree directory is unavailable or refused.',
  });
});

it('loads previous output with identity checks but without opening a worktree', async () => {
  await createStepHostServices(ctx).loadPreviousStepOutput('previous');
  expect(openDirNoFollow).not.toHaveBeenCalled();
  expect(task).toHaveBeenCalledOnce();
  expect(step).toHaveBeenCalledOnce();
  expect(loadPreviousStepOutput).toHaveBeenCalledWith(ctx.db, 'task', 'previous', 2);
});

it('scrubs collector scanError before returning it to a module without mutating the scan', async () => {
  const scan = {
    files: ['a'],
    total: 1,
    truncated: false,
    scanError: 'Cannot scan /host/private/tree (EACCES)',
  };
  vi.mocked(collectImplementationFiles).mockResolvedValue(scan);
  const result = await createStepHostServices(ctx).collectImplementationFiles(
    '/repo/.haive/worktrees/task',
  );
  expect(result).toEqual({ ...scan, scanError: 'Cannot scan [path] (EACCES)' });
  expect(JSON.stringify(result)).not.toContain('/host/private/tree');
  expect(scan.scanError).toBe('Cannot scan /host/private/tree (EACCES)');
});

it.each(['EMFILE', 'ENFILE'])(
  'propagates git spawn %s through the actual host collector',
  async (code) => {
    vi.mocked(loadPreviousStepOutput).mockResolvedValue({
      id: 'row',
      stepId: '01-worktree-setup',
      status: 'done',
      round: 0,
      detect: null,
      output: { baseBranch: 'base', filesTouched: ['a'] },
      iterations: [],
    });
    const actual = await vi.importActual<
      typeof import('../src/step-engine/steps/workflow/_impl-changes.js')
    >('../src/step-engine/steps/workflow/_impl-changes.js');
    vi.mocked(collectImplementationFiles).mockImplementationOnce(actual.collectImplementationFiles);
    const error = Object.assign(new Error('spawn git failed'), { code });
    vi.mocked(gitExec).mockRejectedValue(error);
    await expect(
      createStepHostServices(ctx).collectImplementationFiles('/repo/.haive/worktrees/task'),
    ).rejects.toBe(error);
  },
);

// The insight adapter is exercised through its real loader and a faked SQL seam.
const dialect = new PgDialect();
function insightContext() {
  const reads: unknown[][] = [];
  let answer: unknown[] = [];
  const chain = {
    from() {
      return chain;
    },
    innerJoin() {
      return chain;
    },
    where(sql: Parameters<PgDialect['sqlToQuery']>[0]) {
      reads.push(dialect.sqlToQuery(sql).params);
      return chain;
    },
    orderBy() {
      return chain;
    },
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(answer).then(resolve);
    },
  };
  const select = vi.fn(() => chain);
  const db = { ...ctx.db, select } as unknown as Database;
  return {
    context: { ...ctx, db },
    reads,
    select,
    setAnswer(value: unknown[]) {
      answer = value;
    },
    chain,
  };
}

it('loads insight inventory without a worktree, forwarding options to the bound task only', async () => {
  const f = insightContext();
  // First read contains source output; later rows lack a selected array.
  f.setAnswer([
    { stepId: 'review', raw: '## INSIGHTS\n- INSIGHT: One | a.ts\n- INSIGHT: Two | b.ts' },
  ]);
  const result = await createStepHostServices(f.context).loadUnactedInsights({
    limit: 1,
    includePicked: true,
  });
  expect(result.insights).toHaveLength(1);
  expect(result.omitted).toBe(1);
  expect(result.insights[0]).toMatchObject({ title: 'One', picked: false });
  expect(f.reads.every((params) => params.includes('task'))).toBe(true);
  expect(openDirNoFollow).not.toHaveBeenCalled();
});

it.each([
  ['foreign task', () => task.mockResolvedValue(undefined)],
  ['foreign user', () => task.mockResolvedValue({ id: 'task', userId: 'other', currentRound: 2 })],
  ['foreign step', () => step.mockResolvedValue({ taskId: 'other', round: 2 })],
  ['missing step', () => step.mockResolvedValue(undefined)],
  ['foreign round', () => step.mockResolvedValue({ taskId: 'task', round: 3 })],
  ['future round', () => task.mockResolvedValue({ id: 'task', userId: 'user', currentRound: 1 })],
] as const)('refuses insight reads with %s binding', async (_label, setup) => {
  const f = insightContext();
  setup();
  await expect(createStepHostServices(f.context).loadUnactedInsights()).rejects.toMatchObject({
    name: 'StepHostBindingError',
  });
  expect(f.select).not.toHaveBeenCalled();
});

it('cannot retarget insight reads by mutating context or smuggling identity/path options', async () => {
  const f = insightContext();
  const host = createStepHostServices(f.context);
  Object.assign(f.context, {
    taskId: 'foreign',
    taskStepId: 'foreign-step',
    userId: 'foreign-user',
    round: 99,
    repoPath: '/foreign',
  });
  await host.loadUnactedInsights({
    taskId: 'foreign',
    userId: 'foreign-user',
    worktreePath: '/foreign',
  } as never);
  expect(f.reads.every((params) => params.includes('task') && !params.includes('foreign'))).toBe(
    true,
  );
  expect(dialect.sqlToQuery(task.mock.calls[0]![0].where).params).toEqual(['task']);
  expect(dialect.sqlToQuery(step.mock.calls[0]![0].where).params).toEqual(['step']);
  task.mockResolvedValue({ id: 'task', userId: 'foreign-user', currentRound: 99 });
  await expect(host.loadUnactedInsights()).rejects.toMatchObject({ name: 'StepHostBindingError' });
});

it('refuses insight loading cancelled before identity or after source reads', async () => {
  const f = insightContext();
  const host = createStepHostServices(f.context);
  controller.abort();
  await expect(host.loadUnactedInsights()).rejects.toBeInstanceOf(TaskCancelledError);
  expect(task).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
});

it('normalizes insight cancellation during a pending source read and after its result', async () => {
  const f = insightContext();
  let finish!: (value: unknown[]) => void;
  f.chain.then = (resolve) =>
    new Promise<unknown[]>((r) => {
      finish = r;
    }).then(resolve);
  const pending = createStepHostServices(f.context).loadUnactedInsights();
  const rejected = expect(pending).rejects.toBeInstanceOf(TaskCancelledError);
  // Let the identity lookups settle and the source read start.
  while (!finish) await Promise.resolve();
  controller.abort();
  await rejected;
  finish([]);
});

it('checks cancellation after identity reads before touching insight sources', async () => {
  const f = insightContext();
  step.mockImplementationOnce(async () => {
    controller.abort();
    return { taskId: 'task', round: 2 };
  });
  await expect(createStepHostServices(f.context).loadUnactedInsights()).rejects.toBeInstanceOf(
    TaskCancelledError,
  );
  expect(f.select).not.toHaveBeenCalled();
});
