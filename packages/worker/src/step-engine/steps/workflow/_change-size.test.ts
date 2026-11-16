import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StepContext } from '../../step-definition.js';
import type { FileTexts } from '@haive/shared/change-size';

const fake = vi.hoisted(() => ({
  read: vi.fn(),
  git: vi.fn(),
  collect: vi.fn(),
  init: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  openDirNoFollow: async () => ({ fd: 123, close: fake.close }),
  readFileNoFollow: fake.read,
}));
vi.mock('../../../repo/git-exec.js', () => ({ gitExec: fake.git }));
vi.mock('./_impl-changes.js', () => ({
  collectImplementationFiles: fake.collect,
  collectChangeSet: fake.collect,
}));
vi.mock('../onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: async () => ({ output: { baseBranch: 'main' } }),
}));

const oid = 'a'.repeat(40);
let TaskCancelledError: typeof import('../../step-definition.js').TaskCancelledError;
const source = new TextEncoder().encode('x=1\n');
const metric = vi.fn((files: FileTexts[]) => ({
  version: 7,
  total: { nullFiles: files.filter((f) => f.base === null || f.head === null).length },
  touched: files.map((f) => f.path),
  excluded: [],
  files: files.map((f) => ({
    path: f.path,
    size: f.base === null || f.head === null ? null : { net: 3 },
  })),
}));
function context() {
  const controller = new AbortController();
  const events: any[] = [];
  const insert = vi.fn(() => ({
    values: (row: any) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          events.push(row);
          return [row];
        },
      }),
    }),
  }));
  const ctx = {
    taskId: 'task',
    taskStepId: 'step',
    round: 0,
    repoPath: '/repo',
    signal: controller.signal,
    throwIfCancelled() {
      if (controller.signal.aborted) throw new TaskCancelledError();
    },
    logger: { warn: vi.fn() },
    db: { query: { taskEvents: { findFirst: async () => undefined } }, insert },
  } as unknown as StepContext;
  return { ctx, controller, events, insert };
}
beforeEach(async () => {
  vi.resetModules();
  ({ TaskCancelledError } = await import('../../step-definition.js'));
  vi.clearAllMocks();
  fake.close.mockResolvedValue(undefined);
  fake.collect.mockResolvedValue({
    files: ['a.py', 'b.py'],
    total: 2,
    truncated: false,
    scanError: null,
  });
  fake.git.mockImplementation(async (args: string[]) => ({
    stdout: args[0] === 'merge-base' ? oid : '',
  }));
  fake.read.mockResolvedValue({ data: source, truncated: false });
  fake.init.mockResolvedValue(metric);
  vi.doMock('@haive/shared/change-size', async () => ({
    ...(await vi.importActual<typeof import('@haive/shared/change-size')>(
      '@haive/shared/change-size',
    )),
    CHANGE_SIZE_VERSION: 7,
    CHANGE_SIZE_DEPENDENCIES: {
      runtimeVersion: 'runtime-test',
      grammarPackageVersion: 'grammar-test',
    },
    initializeChangeSize: fake.init,
  }));
});
afterEach(() => {
  vi.doUnmock('@haive/shared/change-size');
});

it('logs the original initialization fault, leaves no attempt row and retries the same attempt', async () => {
  const err = new Error('bad WASM');
  fake.init.mockRejectedValueOnce(err);
  const { recordChangeSize } = await import('./_change-size.js');
  const { ctx, events } = context();
  expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toEqual({
    state: 'unknown',
    reason: 'Change-size counter unavailable.',
    retryable: true,
  });
  expect(ctx.logger.warn).toHaveBeenCalledWith({ err }, expect.any(String));
  expect(events).toHaveLength(0);
  expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toMatchObject({
    state: 'measured',
  });
  expect(events).toHaveLength(1);
});

it('contains a missing counter dependency at lazy import and retries after it becomes available', async () => {
  let unavailable = true;
  const err = new Error('missing web-tree-sitter');
  vi.doMock('@haive/shared/change-size', async () => {
    if (unavailable) throw err;
    return {
      ...(await vi.importActual<typeof import('@haive/shared/change-size')>(
        '@haive/shared/change-size',
      )),
      initializeChangeSize: fake.init,
    };
  });
  const { recordChangeSize } = await import('./_change-size.js');
  const { ctx, events } = context();
  expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toEqual({
    state: 'unknown',
    reason: 'Change-size counter unavailable.',
    retryable: true,
  });
  expect(ctx.logger.warn).toHaveBeenCalledWith(
    { err: expect.objectContaining({ cause: err }) },
    expect.any(String),
  );
  expect(events).toHaveLength(0);
  unavailable = false;
  expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toMatchObject({
    state: 'measured',
  });
});

it('aborts mid-loop without freezing a measured attempt and measures again on resume', async () => {
  const { recordChangeSize } = await import('./_change-size.js');
  const { ctx, controller, events } = context();
  fake.read.mockImplementationOnce(async () => {
    controller.abort();
    return { data: source, truncated: false };
  });
  await expect(recordChangeSize(ctx, '/repo/work', 'before', null, -1)).rejects.toBeInstanceOf(
    TaskCancelledError,
  );
  expect(fake.read).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(0);
  const resumed = context();
  expect(await recordChangeSize(resumed.ctx, '/repo/work', 'before', null, -1)).toMatchObject({
    state: 'measured',
  });
});

it.each(['init', 'git', 'read', 'persist'])(
  'passes TaskCancelledError through the %s catch',
  async (stage) => {
    const { recordChangeSize } = await import('./_change-size.js');
    const { ctx, events, insert } = context();
    const err = new TaskCancelledError();
    if (stage === 'init') fake.init.mockRejectedValueOnce(err);
    if (stage === 'git')
      fake.git.mockImplementationOnce(async () => ({ stdout: oid })).mockRejectedValueOnce(err);
    if (stage === 'read') fake.read.mockRejectedValueOnce(err);
    if (stage === 'persist')
      insert.mockImplementationOnce(() => {
        throw err;
      });
    await expect(recordChangeSize(ctx, '/repo/work', 'before', null, -1)).rejects.toBe(err);
    expect(events).toHaveLength(0);
  },
);

it.each(['read', 'git'])(
  'logs a non-containment %s failure and makes the whole measurement unknown',
  async (stage) => {
    const { measureImplementationSize } = await import('./_change-size.js');
    const { ctx } = context();
    const err = Object.assign(new Error('unavailable'), { code: 'EMFILE' });
    if (stage === 'read') fake.read.mockRejectedValueOnce(err);
    else fake.git.mockImplementationOnce(async () => ({ stdout: oid })).mockRejectedValueOnce(err);
    expect(await measureImplementationSize(ctx, '/repo/work')).toMatchObject({ state: 'unknown' });
    expect(ctx.logger.warn).toHaveBeenCalledWith({ err }, expect.any(String));
    expect(metric).not.toHaveBeenCalled();
  },
);

it('logs the original persistence error', async () => {
  const { recordChangeSize } = await import('./_change-size.js');
  const { ctx, insert } = context();
  const err = new Error('database unavailable');
  insert.mockImplementationOnce(() => {
    throw err;
  });
  expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toMatchObject({
    state: 'unknown',
  });
  expect(ctx.logger.warn).toHaveBeenCalledWith({ err }, expect.any(String));
});

it.each(['EMFILE', 'ETIMEDOUT'])(
  'does not freeze an environment failure (%s) and retries the attempt',
  async (code) => {
    const { recordChangeSize } = await import('./_change-size.js');
    const { ctx, events } = context();
    const err = Object.assign(new Error('environment unavailable'), { code });
    fake.read.mockRejectedValueOnce(err);
    expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toMatchObject({
      state: 'unknown',
    });
    expect(events).toHaveLength(0);
    expect(await recordChangeSize(ctx, '/repo/work', 'before', null, -1)).toMatchObject({
      state: 'measured',
    });
    expect(events).toHaveLength(1);
  },
);

it('normalizes ./a.py and a.py before reading, and counts a repeated invalid name once as null', async () => {
  const { measureImplementationSize } = await import('./_change-size.js');
  fake.collect.mockResolvedValue({
    files: ['./a.py', 'a.py', '/workspace/b.py', '/workspace/b.py'],
    truncated: false,
  });
  const { ctx } = context();
  const measured = await measureImplementationSize(ctx, '/repo/work');
  expect(measured.result?.touched).toEqual(['a.py', '/workspace/b.py']);
  expect(measured.result?.files).toEqual([
    { path: 'a.py', size: { net: 3 } },
    { path: '/workspace/b.py', size: null },
  ]);
  expect(fake.read).toHaveBeenCalledTimes(1);
});

it('does not read unsupported bytes or spend the byte budget on them', async () => {
  const { measureImplementationSize } = await import('./_change-size.js');
  fake.collect.mockResolvedValue({ files: ['data.json', 'a.py'], truncated: false });
  const { ctx } = context();
  const measured = await measureImplementationSize(ctx, '/repo/work', undefined, {
    totalBytes: source.length,
  });
  expect(measured.state).toBe('measured');
  expect(measured.result?.files[0]).toEqual({ path: 'data.json', size: null });
  expect(fake.read).toHaveBeenCalledTimes(1);
  expect(fake.git.mock.calls.filter(([args]) => args[0] === 'ls-tree')).toHaveLength(1);
});

it('counts an invalid name once as null even if its spelling looks like an excluded path', async () => {
  const { measureImplementationSize } = await import('./_change-size.js');
  fake.collect.mockResolvedValue({
    files: ['/workspace/docs/a.py', '/workspace/docs/a.py'],
    truncated: false,
  });
  // Use the real initialized counter here: exclusion policy must not mask a bad reported name.
  const actual = await vi.importActual<typeof import('@haive/shared/change-size')>(
    '@haive/shared/change-size',
  );
  fake.init.mockResolvedValueOnce(await actual.initializeChangeSize());
  const { ctx } = context();
  const measured = await measureImplementationSize(ctx, '/repo/work');
  expect(measured.result?.files).toEqual([{ path: '/workspace/docs/a.py', size: null }]);
  expect(measured.result?.excluded).toEqual([]);
  expect(measured.result?.total.nullFiles).toBe(1);
});

it('uses exported metric and dependency versions in the event payload and identity', async () => {
  const { recordChangeSize } = await import('./_change-size.js');
  const { ctx, events } = context();
  await recordChangeSize(ctx, '/repo/work', 'before', null, -1);
  expect(events[0].payload).toMatchObject({
    version: 7,
    counterVersion: 7,
    runtimeVersion: 'runtime-test',
    grammarPackageVersion: 'grammar-test',
  });
  const firstId = events[0].id;
  vi.resetModules();
  vi.doMock('@haive/shared/change-size', async () => ({
    ...(await vi.importActual<typeof import('@haive/shared/change-size')>(
      '@haive/shared/change-size',
    )),
    CHANGE_SIZE_VERSION: 8,
    initializeChangeSize: fake.init,
  }));
  const next = await import('./_change-size.js');
  await next.recordChangeSize(ctx, '/repo/work', 'before', null, -1);
  expect(events[1].id).not.toBe(firstId);
});
