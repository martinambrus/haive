import { randomBytes } from 'node:crypto';
import { loadDependencyPolicy } from '../src/step-engine/steps/workflow/_dependency-policy.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import { readReviewDiff, REVIEW_RETAINED_CONTENT_BYTES } from '../src/step-engine/review-diff.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { gitRun } from '../src/repo/git-exec.js';
import { openFileNoFollow, lstatNoFollow } from '@haive/shared/fs-safe';

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async () => ({ output: { baseBranch: 'base' } })),
}));
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', () => ({
  collectImplementationFiles: vi.fn(),
}));
vi.mock('../src/step-engine/steps/workflow/_dependency-policy.js', () => ({
  loadDependencyPolicy: vi.fn(async () => ({})),
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [] })),
}));
vi.mock('../src/repo/git-exec.js', () => ({ gitRun: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  openFileNoFollow: vi.fn(),
  lstatNoFollow: vi.fn(),
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async () => {
  const { secretMaskPolicy } = await import('../src/queues/cli-exec/secret-mask-policy.js');
  return { taskSecretMaskPolicy: vi.fn(async () => secretMaskPolicy({})) };
});
const scope = { files: ['a'], total: 1, truncated: false, scanError: null };
let controller: AbortController;
let ctx: StepContext;
const close = vi.fn(async () => {});
const stat = { size: 1, mode: 0o644, mtimeMs: 1, ctimeMs: 1 };
const options = { worktreePath: '/repo', maxBytes: 4096, includeFileContents: true };
beforeEach(() => {
  vi.resetAllMocks();
  controller = new AbortController();
  ctx = {
    taskId: 'task',
    taskStepId: 'step',
    userId: 'user',
    round: 0,
    repoPath: '/repo',
    workspacePath: '/repo',
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    signal: controller.signal,
    db: {} as Database,
    logger: logger.child({ test: 'read' }),
    throwIfCancelled() {
      if (controller.signal.aborted) throw new TaskCancelledError();
    },
    async emitProgress() {},
  };
  vi.mocked(lstatNoFollow).mockResolvedValue({
    kind: 'file',
    stats: stat,
  } as unknown as NonNullable<Awaited<ReturnType<typeof lstatNoFollow>>>);
  vi.mocked(collectImplementationFiles).mockResolvedValue(scope);
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => ({
    code: 0,
    stderr: '',
    stdout: args.includes('merge-base')
      ? 'a'.repeat(40)
      : args.includes('--name-status')
        ? 'M\0a\0'
        : args.includes('ls-files')
          ? ''
          : 'diff\n+z\n',
  }));
  vi.mocked(openFileNoFollow).mockImplementation(
    async () =>
      ({
        stat: async () => stat,
        close,
        read: async (buffer: Buffer, _off: number, _len: number, position: number) => {
          if (position === 0) buffer[0] = 122;
          return { bytesRead: position === 0 ? 1 : 0, buffer };
        },
      }) as unknown as Awaited<ReturnType<typeof openFileNoFollow>>,
  );
});
afterEach(() => vi.useRealTimers());
it('refuses an unreadable fork point', async () => {
  vi.mocked(gitRun).mockResolvedValue({ code: 1, stdout: '', stderr: '' });
  expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('unavailable');
});
it('refuses a changed scope and a same-size content change between captures', async () => {
  vi.mocked(collectImplementationFiles)
    .mockResolvedValueOnce(scope)
    .mockResolvedValueOnce({ ...scope, total: 2, truncated: true });
  expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('unavailable');
  vi.mocked(collectImplementationFiles).mockResolvedValue(scope);
  let reads = 0;
  vi.mocked(openFileNoFollow).mockImplementation(async () => {
    const byte = ++reads;
    return {
      stat: async () => stat,
      close,
      read: async (buffer: Buffer, _o: number, _l: number, position: number) => {
        buffer[0] = byte;
        return { bytesRead: position === 0 ? 1 : 0, buffer };
      },
    } as unknown as Awaited<ReturnType<typeof openFileNoFollow>>;
  });
  expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('unavailable');
});
it('normalizes cancellation during a held-descriptor read and closes it', async () => {
  vi.useFakeTimers();
  const read = vi.fn(
    () => new Promise((resolve) => setTimeout(() => resolve({ bytesRead: 0 }), 100)),
  );
  vi.mocked(openFileNoFollow).mockResolvedValue({
    stat: async () => stat,
    close,
    read,
  } as unknown as Awaited<ReturnType<typeof openFileNoFollow>>);
  const promise = readReviewDiff(ctx, '/repo', options);
  const rejected = expect(promise).rejects.toBeInstanceOf(TaskCancelledError);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalled();
  controller.abort();
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
});
it('discloses partial scope and rejects an inconsistent git path list', async () => {
  vi.mocked(collectImplementationFiles).mockResolvedValue({ ...scope, total: 2, truncated: true });
  const partial = await readReviewDiff(ctx, '/repo', options);
  expect(partial.status, JSON.stringify(partial)).toBe('ready');
  if (partial.status === 'ready') expect(JSON.parse(partial.content).coverage.partial).toBe(true);
  vi.mocked(collectImplementationFiles).mockResolvedValue({ ...scope, files: ['other'] });
  expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('unavailable');
});

it('invalidates the hash when a git-changed file outside a capped scope changes', async () => {
  vi.mocked(collectImplementationFiles).mockResolvedValue({ ...scope, total: 2, truncated: true });
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => ({
    code: 0,
    stderr: '',
    stdout: args.includes('merge-base')
      ? 'a'.repeat(40)
      : args.includes('--name-status')
        ? 'M\0a\0M\0b\0'
        : args.includes('ls-files')
          ? ''
          : 'diff\n+z\n',
  }));
  let byte = 65;
  vi.mocked(openFileNoFollow).mockImplementation(
    async (_anchor, rel) =>
      ({
        stat: async () => stat,
        close,
        read: async (buffer: Buffer, _o: number, _l: number, position: number) => {
          buffer[0] = rel === 'b' ? byte : 122;
          return { bytesRead: position === 0 ? 1 : 0, buffer };
        },
      }) as unknown as Awaited<ReturnType<typeof openFileNoFollow>>,
  );
  const first = await readReviewDiff(ctx, '/repo', options);
  byte = 66;
  const second = await readReviewDiff(ctx, '/repo', options);
  expect(first.status).toBe('ready');
  expect(second.status).toBe('ready');
  if (first.status === 'ready' && second.status === 'ready')
    expect(first.diffHash).not.toBe(second.diffHash);
});

it.each(['link', 'directory', 'missing', 'gitlink', 'absolute', 'parent'])(
  'keeps review ready and discloses a %s entry as partial coverage',
  async (kind) => {
    const p = kind === 'absolute' ? '/outside' : kind === 'parent' ? '../outside' : 'odd';
    vi.mocked(collectImplementationFiles).mockResolvedValue({
      ...scope,
      files: ['a', p],
      total: 2,
    });
    vi.mocked(lstatNoFollow).mockImplementation(async (_anchor, rel) => {
      if (rel === 'a') return { kind: 'file', stats: stat } as never;
      if (kind === 'missing') return null;
      return {
        kind: kind === 'gitlink' ? 'directory' : kind === 'link' ? 'symlink' : kind,
        stats: stat,
      } as never;
    });
    const run = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      kind === 'gitlink' && args[1].includes('--stage')
        ? { code: 0, stdout: '160000 ' + 'a'.repeat(40) + ' 0\todd\0', stderr: '' }
        : run(...args),
    );
    const result = await readReviewDiff(ctx, '/repo', options);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    if (result.status !== 'ready') return;
    const payload = JSON.parse(result.content);
    expect(payload.coverage.partial).toBe(true);
    expect(payload.files).toContainEqual(
      expect.objectContaining({
        path: p,
        kind: kind === 'absolute' || kind === 'parent' ? 'invalid' : kind,
      }),
    );
    expect(payload.diff).toContain('+z');
    expect(openFileNoFollow).not.toHaveBeenCalledWith(
      '/repo',
      p,
      expect.anything(),
      expect.anything(),
    );
  },
);

it('sanitizes a bound-value database error before returning a reason', async () => {
  const value = randomBytes(24).toString('hex');
  const error = Object.assign(new Error('Failed query with ' + value), { params: [value] });
  vi.mocked(loadDependencyPolicy).mockRejectedValueOnce(error);
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'Database operation failed' });
  expect(JSON.stringify(result)).not.toContain(value);
});
it('scrubs a host path from a returned failure reason', async () => {
  vi.mocked(loadDependencyPolicy).mockRejectedValueOnce(
    new Error('Cannot read /host/private/tree/file'),
  );
  expect(await readReviewDiff(ctx, '/repo', options)).toMatchObject({
    status: 'unavailable',
    reason: 'Cannot read [path]',
  });
});
it.each(['EMFILE', 'ENFILE'])('rethrows %s for the step retry boundary', async (code) => {
  const error = Object.assign(new Error(code), { code });
  vi.mocked(openFileNoFollow).mockRejectedValueOnce(error);
  await expect(readReviewDiff(ctx, '/repo', options)).rejects.toBe(error);
});

it('disables optional locks on review git reads and forwards the abort signal', async () => {
  expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('ready');
  for (const call of vi.mocked(gitRun).mock.calls) {
    expect(call[1][0]).toBe('--no-optional-locks');
    expect(call[3]?.signal).toBe(ctx.signal);
  }
});
it.each([false, true])(
  'caps cumulative retained contents and lists omissions (contents %s)',
  async (includeFileContents) => {
    vi.mocked(collectImplementationFiles).mockResolvedValue({
      ...scope,
      files: ['a', 'b'],
      total: 2,
    });
    const run = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      args[1].includes('--others') ? { code: 0, stdout: 'b\0', stderr: '' } : run(...args),
    );
    const result = await readReviewDiff(
      ctx,
      '/repo',
      { ...options, includeFileContents },
      { retainedContentBytes: 0 },
    );
    expect(result.status, JSON.stringify(result)).toBe('ready');
    if (result.status !== 'ready') return;
    const payload = JSON.parse(result.content);
    expect(payload.untrackedContents).toEqual([]);
    expect(payload.fileContents).toEqual([]);
    expect(payload.coverage.partial).toBe(true);
    expect(payload.omittedContents).toContainEqual({ path: 'b', reason: 'retained-content-limit' });
  },
);

it('pins the production retention cap and spends one cumulative budget across files', async () => {
  expect(REVIEW_RETAINED_CONTENT_BYTES).toBe(16 * 1024 * 1024);
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'b'],
    total: 2,
  });
  const result = await readReviewDiff(ctx, '/repo', options, { retainedContentBytes: 1 });
  expect(result.status, JSON.stringify(result)).toBe('ready');
  if (result.status !== 'ready') return;
  const payload = JSON.parse(result.content);
  expect(payload.fileContents).toEqual([{ path: 'a', content: 'z' }]);
  expect(payload.omittedContents).toContainEqual({ path: 'b', reason: 'retained-content-limit' });
});
