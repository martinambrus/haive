import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitRun } from '../repo/git-exec.js';
import * as gitCommands from '../repo/git-exec.js';
import { reviewWatermarkIntake, reviewWatermarkOrder } from './review-watermarks.js';
const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@local',
};
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function git(dir: string, args: string[]) {
  const res = await gitRun(dir, args, identity);
  if (res.code) throw new Error(res.stderr || res.stdout);
  return res.stdout.trim();
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'watermark-ancestry-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(dir, 'code'), 'one');
  await git(dir, ['add', 'code']);
  await git(dir, ['commit', '-qm', 'one']);
  const one = await git(dir, ['rev-parse', 'HEAD']);
  await writeFile(path.join(dir, 'code'), 'two');
  await git(dir, ['commit', '-qam', 'two']);
  const two = await git(dir, ['rev-parse', 'HEAD']);
  return { dir, one, two };
}
describe('review watermark Git proof', () => {
  it('orders real commits in both directions and rejects missing/foreign proof', async () => {
    const { dir, one, two } = await fixture();
    expect(
      (await reviewWatermarkOrder(dir, { kbSyncedCommit: one }, { kbSyncedCommit: two }))(one, two),
    ).toBe('incoming');
    expect(
      (await reviewWatermarkOrder(dir, { kbSyncedCommit: two }, { kbSyncedCommit: one }))(two, one),
    ).toBe('local');
    await git(dir, ['checkout', '-q', '--detach', one]);
    expect(
      (await reviewWatermarkOrder(dir, { kbSyncedCommit: two }, { kbSyncedCommit: one }))(two, one),
    ).toBe('local');
    await git(dir, ['checkout', '-q', 'main']);
    await expect(
      reviewWatermarkIntake(dir, { kbSyncedCommit: 'f'.repeat(40), planSyncedCommit: one }),
    ).rejects.toThrow('fetch its commit history');
    expect(await reviewWatermarkIntake(dir, undefined)).toEqual({});
    await git(dir, ['checkout', '-q', '--orphan', 'foreign']);
    await git(dir, ['commit', '-qm', 'foreign']);
    await expect(reviewWatermarkIntake(dir, { kbSyncedCommit: two })).rejects.toThrow(
      'another history',
    );
  });
  it('R1 keeps a known divergent fork incomparable instead of treating it as foreign', async () => {
    const { dir, one, two } = await fixture();
    await git(dir, ['checkout', '-q', '-b', 'fork', one]);
    await writeFile(path.join(dir, 'code'), 'fork');
    await git(dir, ['commit', '-qam', 'fork']);
    const fork = await git(dir, ['rev-parse', 'HEAD']);
    expect(
      (await reviewWatermarkOrder(dir, { kbSyncedCommit: two }, { kbSyncedCommit: fork }))(
        two,
        fork,
      ),
    ).toBe('incomparable');
  });
  it.each(['missing', 'foreign'] as const)(
    'R1 refuses differing incoming progress when stored proof is %s',
    async (kind) => {
      const { dir, one } = await fixture();
      let stored = 'f'.repeat(40);
      if (kind === 'foreign') {
        await git(dir, ['checkout', '-q', '--orphan', 'foreign']);
        await git(dir, ['commit', '-qm', 'foreign']);
        stored = await git(dir, ['rev-parse', 'HEAD']);
        await git(dir, ['checkout', '-q', 'main']);
      }
      await expect(
        reviewWatermarkOrder(dir, { kbSyncedCommit: stored }, { kbSyncedCommit: one }),
      ).rejects.toThrow(kind === 'missing' ? 'fetch its commit history' : 'another history');
    },
  );
  it.each([128, 124, -1])(
    'refuses an unreadable ancestry result %s instead of treating it as false',
    async (code) => {
      const { dir, one, two } = await fixture();
      const original = gitCommands.gitRun;
      vi.spyOn(gitCommands, 'gitRun').mockImplementation(async (cwd, args, ...rest) =>
        args[0] === 'merge-base'
          ? { code, stdout: '', stderr: 'unreadable Git' }
          : original(cwd, args, ...rest),
      );
      await expect(
        reviewWatermarkOrder(dir, { kbSyncedCommit: one }, { kbSyncedCommit: two }),
      ).rejects.toThrow('ancestry could not be read');
    },
  );
});
