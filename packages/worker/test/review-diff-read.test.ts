import { createHash } from 'node:crypto';
import { taskSecretMaskPolicy } from '../src/queues/cli-exec/secret-mask.js';
import { secretMaskPolicy } from '../src/queues/cli-exec/secret-mask-policy.js';
import { randomBytes } from 'node:crypto';
import { loadDependencyPolicy } from '../src/step-engine/steps/workflow/_dependency-policy.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { TaskCancelledError, type StepContext } from '@haive/shared/step';
import {
  readReviewDiff,
  serializeReviewPayload,
  REVIEW_RETAINED_CONTENT_BYTES,
  REVIEW_GITLINK_PATHSPEC_BYTES,
} from '../src/step-engine/review-diff.js';
import { collectImplementationFiles } from '../src/step-engine/steps/workflow/_impl-changes.js';
import { gitRun } from '../src/repo/git-exec.js';
import { nestedRepositoryHead } from '../src/repo/nested-repository.js';
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
vi.mock('../src/repo/nested-repository.js', () => ({
  nestedRepositoryHead: vi.fn(async () => null),
}));
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
it('uses the held cwd for capture git calls and both helper chains', async () => {
  const gitCwd = '/proc/self/fd/42';
  expect((await readReviewDiff(ctx, '/repo', options, { gitCwd })).status).toBe('ready');
  for (const [cwd] of vi.mocked(gitRun).mock.calls) expect(cwd).toBe(gitCwd);
  for (const [, , limits] of vi.mocked(collectImplementationFiles).mock.calls)
    expect(limits?.gitCwd).toBe(gitCwd);
  expect(loadDependencyPolicy).toHaveBeenCalledWith(
    ctx,
    '/repo',
    expect.objectContaining({ gitCwd }),
  );
});

it.each(['index', 'checkout'] as const)(
  'fingerprints the %s gitlink target and detects a capture race',
  async (source) => {
    let target = 'b'.repeat(40);
    vi.mocked(lstatNoFollow).mockResolvedValue({ kind: 'directory', stats: stat } as never);
    const run = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      args[1].includes('--stage')
        ? {
            code: 0,
            stderr: '',
            stdout: `160000 ${source === 'index' ? target : 'b'.repeat(40)} 0\ta\0`,
          }
        : run(...args),
    );
    vi.mocked(nestedRepositoryHead).mockImplementation(async () => ({
      commit: source === 'checkout' ? target : 'b'.repeat(40),
    }));
    const first = await readReviewDiff(ctx, '/repo', options);
    target = 'c'.repeat(40);
    const second = await readReviewDiff(ctx, '/repo', options);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (first.status !== 'ready' || second.status !== 'ready') return;
    expect(first.diffHash).not.toBe(second.diffHash);
    expect(JSON.parse(first.content).changeHash).not.toBe(JSON.parse(second.content).changeHash);
    let captures = 0;
    const read = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) => {
      if (args[1].includes('--stage') && ++captures === 2) target = 'd'.repeat(40);
      return read(...args);
    });
    expect((await readReviewDiff(ctx, '/repo', options)).status).toBe('unavailable');
  },
);
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

it.each([
  { path: 'x.bak', policy: {}, withheld: true },
  { path: 'x.bak', policy: { allow: ['**/*.bak'] }, withheld: false },
  { path: 'private.txt', policy: { denyExtend: ['private.txt'] }, withheld: true },
])(
  'keeps ordinary evidence beside $path under repository policy $policy',
  async ({ path, policy, withheld }) => {
    vi.mocked(taskSecretMaskPolicy).mockResolvedValue(secretMaskPolicy(policy));
    vi.mocked(collectImplementationFiles).mockResolvedValue({
      ...scope,
      files: ['a', path],
      total: 2,
    });
    const run = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      args[1].includes('--others') ? { code: 0, stdout: path + '\0', stderr: '' } : run(...args),
    );
    const result = await readReviewDiff(ctx, '/repo', options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result).toMatchObject({ partial: withheld });
    const payload = JSON.parse(result.content);
    expect(payload.diff).toContain('+z');
    expect(payload.files).toContainEqual(
      expect.objectContaining({
        path: 'a',
        kind: 'text',
        hash: createHash('sha256').update('z').digest('hex'),
      }),
    );
    expect(payload.fileContents).toContainEqual({ path: 'a', content: 'z' });
    expect(payload.files).toContainEqual(
      expect.objectContaining({ path, kind: withheld ? 'withheld' : 'text', size: 1, mode: 0o644 }),
    );
    if (withheld) {
      expect(payload.files.find((f: { path: string }) => f.path === path).hash).toBeUndefined();
      expect(vi.mocked(openFileNoFollow).mock.calls.some((call) => call[1] === path)).toBe(false);
      expect(
        vi.mocked(gitRun).mock.calls.some((call) => call[1].includes(':(literal)' + path)),
      ).toBe(false);
    }
  },
);
it.each(['deleted'])('withholds the whole capture for a denied %s path', async (kind) => {
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'x.bak'],
    total: 2,
  });
  vi.mocked(lstatNoFollow).mockImplementation(async (_anchor, rel) =>
    rel === 'x.bak' ? null : ({ kind: 'file', stats: stat } as never),
  );
  const run = vi.mocked(gitRun).getMockImplementation()!;
  vi.mocked(gitRun).mockImplementation(async (...args) =>
    args[1].includes('--name-status')
      ? { code: 0, stdout: (kind === 'deleted' ? 'D\0x.bak\0' : '') + 'A\0a\0', stderr: '' }
      : run(...args),
  );
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status !== 'ready') return;
  const payload = JSON.parse(result.content);
  expect(payload.diff).toBe('');
  expect(
    payload.files.every((f: { kind: string; hash?: string }) => f.kind === 'withheld' && !f.hash),
  ).toBe(true);
  expect(openFileNoFollow).not.toHaveBeenCalled();
});

it('returns a small change ready when the index exceeds maxBytes', async () => {
  const maxBytes = 1024;
  const index = Array.from(
    { length: 20 },
    (_, i) => '100644 ' + 'a'.repeat(40) + ' 0\tunchanged-' + i + '\0',
  ).join('');
  expect(Buffer.byteLength(index)).toBeGreaterThan(maxBytes);
  const run = vi.mocked(gitRun).getMockImplementation()!;
  vi.mocked(gitRun).mockImplementation(async (...args) => {
    if (!args[1].includes('--stage')) return run(...args);
    const stdout = args[1].includes(':(literal)a') ? '' : index;
    return Buffer.byteLength(stdout) > args[3]!.maxBuffer!
      ? { code: -1, noExit: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '', stderr: '' }
      : { code: 0, stdout, stderr: '' };
  });
  expect(await readReviewDiff(ctx, '/repo', { ...options, maxBytes })).toMatchObject({
    status: 'ready',
    partial: false,
  });
  const stageCalls = vi.mocked(gitRun).mock.calls.filter((call) => call[1].includes('--stage'));
  expect(stageCalls).toHaveLength(2);
  for (const call of stageCalls)
    expect(call[1]).toEqual([
      '--no-optional-locks',
      'ls-files',
      '--stage',
      '-z',
      '--',
      ':(literal)a',
    ]);
  for (const call of vi
    .mocked(gitRun)
    .mock.calls.filter((call) => !call[1].includes('--full-index')))
    expect(call[3]!.maxBuffer).toBe(16 * 1024 * 1024);
});
it('reports overflowing metadata as unavailable rather than a large change', async () => {
  vi.mocked(gitRun).mockResolvedValueOnce({
    code: -1,
    noExit: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: '',
    stderr: '',
  });
  expect(await readReviewDiff(ctx, '/repo', options)).toMatchObject({
    status: 'unavailable',
    partial: true,
  });
});

it.each(['EMFILE', 'ENFILE'])('rethrows git spawn %s for step retry', async (code) => {
  vi.mocked(gitRun).mockResolvedValueOnce({
    code: -1,
    noExit: code,
    stdout: '',
    stderr: 'spawn refused in /host/private/tree',
  });
  await expect(readReviewDiff(ctx, '/repo', options)).rejects.toMatchObject({ code });
});

it.each(['collector', 'serializer'])(
  'scrubs scan stderr at the %s unavailable boundary',
  async (source) => {
    const failedScope = {
      ...scope,
      scanError: 'git ended without an exit status in /host/private/tree (EACCES)',
    };
    vi.mocked(collectImplementationFiles).mockResolvedValue(failedScope);
    const result =
      source === 'collector'
        ? await readReviewDiff(ctx, '/repo', options)
        : serializeReviewPayload(
            {
              forkPoint: 'a'.repeat(40),
              changeHash: 'hash',
              scope: failedScope,
              dependencyPolicy: {},
              reviewDimensions: [],
              diff: '',
              files: [],
            },
            options,
          );
    expect(result).toMatchObject({
      status: 'unavailable',
      scope: { scanError: 'git ended without an exit status in [path] (EACCES)' },
    });
    expect(JSON.stringify(result)).not.toContain('/host/private/tree');
    expect(failedScope.scanError).toContain('/host/private/tree');
  },
);

it.each(['unreadable-lstat', 'unreadable-open', 'other'])(
  'preserves ordinary evidence beside an %s entry',
  async (kind) => {
    vi.mocked(collectImplementationFiles).mockResolvedValue({
      ...scope,
      files: ['a', 'odd'],
      total: 2,
    });
    vi.mocked(lstatNoFollow).mockImplementation(async (_anchor, rel) => {
      if (rel === 'odd' && kind === 'unreadable-lstat')
        throw Object.assign(new Error('refused'), { code: 'EACCES' });
      return { kind: rel === 'odd' && kind === 'other' ? 'other' : 'file', stats: stat } as never;
    });
    const open = vi.mocked(openFileNoFollow).getMockImplementation()!;
    vi.mocked(openFileNoFollow).mockImplementation(async (...args) => {
      if (args[1] === 'odd') throw Object.assign(new Error('refused'), { code: 'EACCES' });
      return open(...args);
    });
    const result = await readReviewDiff(ctx, '/repo', options);
    expect(result).toMatchObject({ status: 'ready', partial: true });
    if (result.status !== 'ready') return;
    const payload = JSON.parse(result.content);
    expect(payload.files).toContainEqual(
      expect.objectContaining({ path: 'odd', kind: kind === 'other' ? 'other' : 'unreadable' }),
    );
    expect(payload.coverage.partial).toBe(true);
    expect(payload.diff).toContain('+z');
    expect(payload.fileContents).toContainEqual({ path: 'a', content: 'z' });
    expect(payload.files.find((f: { path: string }) => f.path === 'odd').hash).toBeUndefined();
    expect(
      vi
        .mocked(gitRun)
        .mock.calls.some(
          (call) => call[1].includes('--full-index') && call[1].includes(':(literal)odd'),
        ),
    ).toBe(false);
    if (kind !== 'unreadable-open')
      expect(vi.mocked(openFileNoFollow).mock.calls.some((call) => call[1] === 'odd')).toBe(false);
  },
);

it.each([
  'config/settings.php/',
  'config/./settings.php',
  './/settings.php',
  'config//settings.php',
  'config/a/../settings.php',
  'config/settings.php/.',
  '.ssh/./id_rsa',
  'id_rsa/',
  '.env/',
])('discloses noncanonical reported name %s without reading its target', async (path) => {
  const secret = randomBytes(24).toString('hex');
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', path],
    total: 2,
  });
  const open = vi.mocked(openFileNoFollow).getMockImplementation()!;
  vi.mocked(lstatNoFollow).mockImplementation(
    async (_anchor, rel) =>
      ({
        kind: 'file',
        stats: rel === 'a' ? stat : { ...stat, size: secret.length },
      }) as never,
  );
  vi.mocked(openFileNoFollow).mockImplementation(async (...args) => {
    if (args[1] === 'a') return open(...args);
    return {
      stat: async () => ({ ...stat, size: secret.length }),
      close,
      read: async (buffer: Buffer, _o: number, _l: number, position: number) => {
        if (!position) buffer.write(secret);
        return { bytesRead: position ? 0 : secret.length, buffer };
      },
    } as unknown as Awaited<ReturnType<typeof openFileNoFollow>>;
  });
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'ready', partial: true });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(createHash('sha256').update(secret).digest('hex'));
  if (result.status !== 'ready') return;
  expect(JSON.parse(result.content).files).toContainEqual({ path, kind: 'invalid' });
  expect(vi.mocked(openFileNoFollow).mock.calls.every((call) => call[1] === 'a')).toBe(true);
  expect(vi.mocked(lstatNoFollow).mock.calls.every((call) => call[1] === 'a')).toBe(true);
  expect(
    vi
      .mocked(gitRun)
      .mock.calls.every((call) =>
        call[1].filter((arg) => arg.startsWith(':(literal)')).every((arg) => arg === ':(literal)a'),
      ),
  ).toBe(true);
});

it.each(['.ENV', 'Config/Settings.php', '.SSH/ID_RSA'])(
  'denies case alias %s even when the filesystem would resolve it',
  async (path) => {
    vi.mocked(collectImplementationFiles).mockResolvedValue({
      ...scope,
      files: ['a', path],
      total: 2,
    });
    const result = await readReviewDiff(ctx, '/repo', options);
    expect(result).toMatchObject({ status: 'ready', partial: true });
    if (result.status !== 'ready') return;
    expect(JSON.parse(result.content).files).toContainEqual(
      expect.objectContaining({ path, kind: 'withheld' }),
    );
    expect(vi.mocked(openFileNoFollow).mock.calls.every((call) => call[1] === 'a')).toBe(true);
    expect(vi.mocked(gitRun).mock.calls.some((call) => call[1].includes(':(literal)' + path))).toBe(
      false,
    );
  },
);
it('keeps a deny when case-folding would turn a different allow spelling into a match', async () => {
  vi.mocked(taskSecretMaskPolicy).mockResolvedValue(secretMaskPolicy({ allow: ['**/*.BAK'] }));
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'x.bak'],
    total: 2,
  });
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status === 'ready')
    expect(JSON.parse(result.content).files).toContainEqual(
      expect.objectContaining({ path: 'x.bak', kind: 'withheld' }),
    );
});

it('keeps ordinary evidence beside a phantom denied reported path', async () => {
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'phantom.bak'],
    total: 2,
  });
  vi.mocked(lstatNoFollow).mockImplementation(async (_anchor, rel) =>
    rel === 'phantom.bak' ? null : ({ kind: 'file', stats: stat } as never),
  );
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status !== 'ready') return;
  const payload = JSON.parse(result.content);
  expect(payload.diff).toContain('+z');
  expect(payload.fileContents).toContainEqual({ path: 'a', content: 'z' });
  expect(payload.files).toContainEqual({ path: 'phantom.bak', kind: 'withheld' });
  expect(payload.files).toContainEqual(
    expect.objectContaining({
      path: 'a',
      kind: 'text',
      hash: createHash('sha256').update('z').digest('hex'),
    }),
  );
  expect(vi.mocked(openFileNoFollow).mock.calls.every((call) => call[1] === 'a')).toBe(true);
  expect(
    vi.mocked(gitRun).mock.calls.some((call) => call[1].includes(':(literal)phantom.bak')),
  ).toBe(false);
});

it('batches gitlink pathspecs within an injected argv-byte budget across the uncapped change', async () => {
  expect(REVIEW_GITLINK_PATHSPEC_BYTES).toBe(32 * 1024);
  const gitlinkPathspecBytes = 24;
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'b'],
    total: 4,
    truncated: true,
  });
  const run = vi.mocked(gitRun).getMockImplementation()!;
  vi.mocked(gitRun).mockImplementation(async (...args) => {
    if (args[1].includes('--name-status'))
      return {
        code: 0,
        stdout: 'M\0a\0M\0b\0M\0c\0M\0d\0',
        stderr: '',
      };
    if (!args[1].includes('--stage')) return run(...args);
    const pathspecs = args[1].slice(args[1].indexOf('--') + 1);
    const bytes = pathspecs.reduce((sum, p) => sum + Buffer.byteLength(p) + 1, 0);
    if (bytes > gitlinkPathspecBytes)
      return {
        code: -1,
        noExit: 'E2BIG',
        stdout: '',
        stderr: '',
      };
    return {
      code: 0,
      stderr: '',
      stdout: pathspecs.includes(':(literal)b') ? '160000 ' + 'a'.repeat(40) + ' 0\tb\0' : '',
    };
  });
  const result = await readReviewDiff(ctx, '/repo', options, { gitlinkPathspecBytes });
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status !== 'ready') return;
  expect(JSON.parse(result.content).files).toContainEqual(
    expect.objectContaining({ path: 'b', kind: 'gitlink' }),
  );
  expect(JSON.parse(result.content).fileContents).toContainEqual({ path: 'a', content: 'z' });
  const calls = vi.mocked(gitRun).mock.calls.filter((call) => call[1].includes('--stage'));
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    const pathspecs = call[1].slice(call[1].indexOf('--') + 1);
    expect(pathspecs.reduce((sum, p) => sum + Buffer.byteLength(p) + 1, 0)).toBeLessThanOrEqual(
      gitlinkPathspecBytes,
    );
    expect(call[3]?.signal).toBe(ctx.signal);
  }
  for (const pass of [calls.slice(0, 2), calls.slice(2)])
    expect(pass.flatMap((call) => call[1].slice(call[1].indexOf('--') + 1))).toEqual([
      ':(literal)a',
      ':(literal)b',
      ':(literal)c',
      ':(literal)d',
    ]);
});

it('discloses an untracked nested repository by kind', async () => {
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', 'nested/'],
    total: 2,
    nestedRepositories: { 'nested/': 'with commits' },
  });
  const run = vi.mocked(gitRun).getMockImplementation()!;
  vi.mocked(gitRun).mockImplementation(async (...args) =>
    args[1].includes('--others') ? { code: 0, stderr: '', stdout: 'nested/\0' } : run(...args),
  );
  const result = await readReviewDiff(ctx, '/repo', options);
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status !== 'ready') return;
  const payload = JSON.parse(result.content);
  expect(payload.files).toContainEqual({ path: 'nested/', kind: 'nested-repository' });
  expect(payload.fileContents).toContainEqual({ path: 'a', content: 'z' });
});

it('discloses a reported name over the gitlink argument budget as invalid', async () => {
  const long = 'x'.repeat(40);
  vi.mocked(collectImplementationFiles).mockResolvedValue({
    ...scope,
    files: ['a', long],
    total: 2,
  });
  const result = await readReviewDiff(ctx, '/repo', options, { gitlinkPathspecBytes: 24 });
  expect(result).toMatchObject({ status: 'ready', partial: true });
  if (result.status !== 'ready') return;
  const payload = JSON.parse(result.content);
  expect(payload.files).toContainEqual({ path: long, kind: 'invalid' });
  expect(payload.fileContents).toContainEqual({ path: 'a', content: 'z' });
  expect(vi.mocked(openFileNoFollow).mock.calls.every((call) => call[1] === 'a')).toBe(true);
});
