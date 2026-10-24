import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { revertKnowledgeBase } from './_kb-commit.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);

const git = async (dir: string, args: string[]): Promise<void> => {
  await exec('git', ['-C', dir, ...args]);
};

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('revertKnowledgeBase', () => {
  let repo: string;
  let shim: KilledGit | null = null;

  afterEach(async () => {
    await shim?.restore();
    shim = null;
    await rm(repo, { recursive: true, force: true });
  });

  const tracked = (): string => path.join(repo, KB_DIR, 'tracked.md');
  const added = (): string => path.join(repo, KB_DIR, 'added.md');

  async function makeRepo(withTrackedKb: boolean): Promise<void> {
    repo = await mkdtemp(path.join(tmpdir(), 'haive-kb-revert-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 't@example.com']);
    await git(repo, ['config', 'user.name', 'T']);
    await git(repo, ['config', 'gc.auto', '0']);
    await mkdir(path.join(repo, KB_DIR), { recursive: true });
    await writeFile(path.join(repo, 'README.md'), 'hi\n');
    if (withTrackedKb) await writeFile(tracked(), 'original\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-qm', 'init']);
    if (withTrackedKb) await writeFile(tracked(), 'declined edit\n');
    await writeFile(added(), 'declined new file\n');
  }

  it('restores a tracked file and removes an untracked one', async () => {
    await makeRepo(true);
    await revertKnowledgeBase(repo);
    expect(await readFile(tracked(), 'utf8')).toBe('original\n');
    expect(await exists(added())).toBe(false);
  });

  it('ignores the exit status of a repository with no tracked knowledge base', async () => {
    await makeRepo(false);
    await revertKnowledgeBase(repo);
    expect(await exists(added())).toBe(false);
  });

  it('rejects when the checkout gave no answer, leaving the edits', async () => {
    await makeRepo(true);
    shim = await killGit(['checkout', 'HEAD']);
    await expect(revertKnowledgeBase(repo)).rejects.toThrow(/git gave no answer/);
    expect(await readFile(tracked(), 'utf8')).toBe('declined edit\n');
    expect(await exists(added())).toBe(true);
  });

  it('rejects when the clean gave no answer', async () => {
    await makeRepo(true);
    shim = await killGit(['clean']);
    await expect(revertKnowledgeBase(repo)).rejects.toThrow(/git gave no answer/);
    expect(await exists(added())).toBe(true);
  });
});
