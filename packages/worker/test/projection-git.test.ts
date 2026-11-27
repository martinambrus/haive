import { expect, it, vi } from 'vitest';
import { projectionEntries } from '../src/project-state/projection-git.js';
const git = vi.hoisted(() => vi.fn());
vi.mock('../src/repo/git-exec.js', () => ({
  gitRun: git,
  gitGaveNoAnswer: () => false,
  GIT_MAX_BUFFER: 64 * 1024 * 1024,
}));
it('parses NUL paths, preserves tabs and newlines, and never aliases an invalid name to U+FFFD', async () => {
  const oid = 'a'.repeat(40),
    other = 'b'.repeat(40);
  const rel = '.haive-data/state/a\t\nb';
  const replacement = '.haive-data/state/\ufffd';
  const raw = (s: string) => Buffer.from(s).toString('latin1');
  git
    .mockResolvedValueOnce({
      code: 0,
      stderr: '',
      stdout:
        `100644 ${oid} 0\t${raw(rel)}\0` +
        `100644 ${oid} 0\t${raw(replacement)}\0` +
        `100644 ${other} 0\t.haive-data/state/\xff\0`,
    })
    .mockResolvedValueOnce({
      code: 0,
      stderr: '',
      stdout:
        `100644 blob ${oid} 4\t${raw(rel)}\0` +
        `100644 blob ${oid} 4\t${raw(replacement)}\0` +
        `100644 blob ${other} 5\t.haive-data/state/\xff\0`,
    });
  const entries = await projectionEntries('/repo');
  expect(entries.index).toEqual(
    new Map([
      [rel, `100644 ${oid}`],
      [replacement, `100644 ${oid}`],
    ]),
  );
  expect(entries.head).toEqual(entries.index);
  expect(entries.sizes).toEqual(new Map([[oid, 4]]));
  expect(git).toHaveBeenCalledTimes(2);
});
