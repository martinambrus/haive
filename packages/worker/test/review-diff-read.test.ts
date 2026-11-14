import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import { readReviewDiff } from '../src/step-engine/review-diff.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { gitRun } from '../src/repo/git-exec.js';
import { openFileNoFollow } from '@haive/shared/fs-safe';

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
  vi.mocked(collectImplementationFiles).mockResolvedValue(scope);
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => ({
    code: 0,
    stderr: '',
    stdout:
      args[0] === 'merge-base'
        ? 'a'.repeat(40)
        : args.includes('--name-status')
          ? 'M\0a\0'
          : args[0] === 'ls-files'
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
    stdout:
      args[0] === 'merge-base'
        ? 'a'.repeat(40)
        : args.includes('--name-status')
          ? 'M\0a\0M\0b\0'
          : args[0] === 'ls-files'
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
