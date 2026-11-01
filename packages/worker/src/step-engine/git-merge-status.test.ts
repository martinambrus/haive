import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitRun } from '../repo/git-push.js';
import { mergeCommitted } from './git-merge.js';

vi.mock('../repo/git-push.js', () => ({ gitRun: vi.fn() }));

it('#280 fix1 mergeCommitted rejects failed status even when the feature is an ancestor', async () => {
  vi.mocked(gitRun).mockImplementation(async (_cwd, argv) => {
    if (argv.includes('MERGE_HEAD')) return { code: 1, stdout: '', stderr: '' };
    if (argv.includes('status')) return { code: 128, stdout: '', stderr: 'unreadable index' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'merge-status-'));
  try {
    await expect(mergeCommitted(dir, 'feature')).rejects.toThrow(/git status.*unreadable index/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(vi.mocked(gitRun).mock.calls.some(([, argv]) => argv.includes('merge-base'))).toBe(false);
});
