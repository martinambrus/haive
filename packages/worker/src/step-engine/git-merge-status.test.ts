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
  await expect(mergeCommitted('/repo', 'feature')).rejects.toThrow(/git status.*unreadable index/);
  expect(vi.mocked(gitRun).mock.calls.some(([, argv]) => argv.includes('merge-base'))).toBe(false);
});
