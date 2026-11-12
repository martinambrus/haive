import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommitStaged, gitStageScopedPaths } from '../src/repo/git-commit.js';
import { gitRun } from '../src/repo/git-exec.js';

vi.mock('../src/repo/git-exec.js', () => ({ gitRun: vi.fn() }));
const codes = [128, 2, -1, 124];
const failure = (code: number) => ({ code, stdout: '', stderr: 'opaque diagnostic' });
beforeEach(() => vi.mocked(gitRun).mockReset());

function expectNoWrite() {
  expect(
    vi.mocked(gitRun).mock.calls.some(([, args]) => ['add', 'commit'].includes(args[0]!)),
  ).toBe(false);
}

describe('commit read decisions with a fake git seam', () => {
  it.each([1, ...codes])('rejects a missing-root tracked read with exit %i', async (code) => {
    vi.mocked(gitRun).mockResolvedValue(failure(code));
    await expect(gitStageScopedPaths('/unit/repo', ['present'], ['absent'])).rejects.toThrow(
      'git tracked paths read failed: opaque diagnostic',
    );
    expectNoWrite();
  });

  it.each(codes)('rejects a missing-root staged read with exit %i', async (code) => {
    vi.mocked(gitRun)
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(failure(code));
    await expect(gitStageScopedPaths('/unit/repo', ['present'], ['absent'])).rejects.toThrow(
      'git staged read failed: opaque diagnostic',
    );
    expectNoWrite();
  });

  it.each(codes)('rejects a staged read with exit %i', async (code) => {
    vi.mocked(gitRun).mockResolvedValue(failure(code));
    await expect(gitCommitStaged('/unit/repo', 'commit')).rejects.toThrow(
      'git staged read failed: opaque diagnostic',
    );
    expectNoWrite();
  });

  describe.each(['whole index', 'scoped changes'] as const)('%s', (scope) => {
    it.each(codes)('rejects a merge read with exit %i', async (code) => {
      const paths = scope === 'scoped changes' ? ['owned'] : undefined;
      vi.mocked(gitRun)
        .mockResolvedValueOnce({ code: paths ? 1 : 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce(failure(code));
      await expect(gitCommitStaged('/unit/repo', 'commit', undefined, paths)).rejects.toThrow(
        'git merge read failed: opaque diagnostic',
      );
      expectNoWrite();
    });
  });
});
