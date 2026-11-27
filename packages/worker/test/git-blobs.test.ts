import { beforeEach, expect, it, vi } from 'vitest';
import { gitBlobSizes, readGitBlobs } from '../src/repo/git-blobs.js';
const git = vi.hoisted(() => vi.fn());
vi.mock('../src/repo/git-exec.js', () => ({ gitRun: git }));
const oid = 'a'.repeat(40);
beforeEach(() => git.mockReset());
const answer = (stdout: string, code = 0) => ({ stdout, stderr: '', code });

it('parses binary content by byte length, deduplicates ids and uses one bounded batch', async () => {
  const bytes = Buffer.from([0, 10, 255, 13]);
  git.mockResolvedValue(answer(`${oid} blob 4\n${bytes.toString('latin1')}\n`));
  const result = await readGitBlobs(
    '/repo',
    [
      { oid, size: 4 },
      { oid, size: 4 },
    ],
    4,
  );
  expect(result.get(oid)).toEqual(bytes);
  expect(git).toHaveBeenCalledExactlyOnceWith('/repo', ['cat-file', '--batch'], undefined, {
    input: Buffer.from(`${oid}\n`),
    encoding: 'latin1',
    maxBuffer: 132,
  });
});
it.each([
  `${oid} missing\n`,
  `${'\xe1'.repeat(40)} blob 1\nx\n`,
  `${oid} tree 1\nx\n`,
  `${oid} blob 2\nx\n`,
  `${'b'.repeat(40)} blob 1\nx\n`,
  `${oid} blob 1\nx`,
  `${oid} blob 1\nx\nextra`,
])('refuses an incomplete or mismatched batch response', async (stdout) => {
  git.mockResolvedValue(answer(stdout));
  await expect(readGitBlobs('/repo', [{ oid, size: 1 }], 1)).rejects.toThrow();
});
it.each([124, -1, 128])('does not turn Git failure %s into missing blobs', async (code) => {
  git.mockResolvedValue(answer('', code));
  await expect(readGitBlobs('/repo', [{ oid, size: 1 }], 1)).rejects.toThrow();
});
it('refuses input and aggregate bounds before spawning', async () => {
  for (const requests of [[{ oid: 'HEAD:a\nb', size: 1 }], [{ oid, size: -1 }], [{ oid, size: 2 }]])
    await expect(readGitBlobs('/repo', requests, 1)).rejects.toThrow();
  expect(git).not.toHaveBeenCalled();
  expect(await readGitBlobs('/repo', [], 1)).toEqual(new Map());
});
it('uses one size batch and validates every object', async () => {
  git.mockResolvedValue(answer(`${oid} blob 0\n`));
  expect(await gitBlobSizes('/repo', [oid, oid])).toEqual(new Map([[oid, 0]]));
  expect(git).toHaveBeenCalledExactlyOnceWith('/repo', ['cat-file', '--batch-check'], undefined, {
    input: Buffer.from(`${oid}\n`),
    maxBuffer: 128,
  });
});

it.each(['missing', 'commit 123', 'tree 0', 'tag 42'])(
  'omits a structurally valid non-blob size response: %s',
  async (entry) => {
    git.mockResolvedValue(answer(`${oid} ${entry}\n`));
    expect(await gitBlobSizes('/repo', [oid])).toEqual(new Map());
  },
);
it.each([
  `${oid} blob BAD\n`,
  `${oid} missing extra\n`,
  `${'b'.repeat(40)} missing\n`,
  `${oid} unknown 1\n`,
])('still rejects malformed or mismatched size output', async (stdout) => {
  git.mockResolvedValue(answer(stdout));
  await expect(gitBlobSizes('/repo', [oid])).rejects.toThrow();
});
