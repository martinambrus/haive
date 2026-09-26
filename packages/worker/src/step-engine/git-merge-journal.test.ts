import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

// What stood at the attempt's manifest the moment the first file was moved into it.
const seen = vi.hoisted(() => ({ manifest: undefined as string | null | undefined }));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    renameNoFollow: async (...args: Parameters<typeof real.renameNoFollow>) => {
      const [anchor, , to] = args;
      const at = to.indexOf('/files/');
      if (seen.manifest === undefined && at !== -1) {
        seen.manifest = await real.readTextNoFollow(anchor, `${to.slice(0, at)}/manifest.json`);
      }
      return real.renameNoFollow(...args);
    },
  };
});

import { captureFixBaseline, relocateFixerChanges } from './git-merge.js';

const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

describe('fixer leftovers journal (real git)', () => {
  it('records what it is about to move before the first file moves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gm-journal-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'init']);
      await git(dir, ['checkout', '-b', 'feature/x']);
      await writeFile(path.join(dir, 'base.txt'), 'feature\n', 'utf8');
      await git(dir, ['commit', '-am', 'feature']);
      await git(dir, ['checkout', 'main']);
      await writeFile(path.join(dir, 'base.txt'), 'main\n', 'utf8');
      await git(dir, ['commit', '-am', 'main']);
      await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      const baseline = await captureFixBaseline(dir, async () => null);
      await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n', 'utf8');

      const out = await relocateFixerChanges(
        dir,
        baseline,
        { taskId: 't1', runId: 'inv1' },
        async () => null,
      );
      expect(out?.moved).toEqual(['stray.txt']);
      expect(JSON.parse(seen.manifest ?? 'null')).toMatchObject({
        journal: true,
        complete: false,
        moving: ['stray.txt'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
