import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killGit } from '../../../test/support/kill-git.js';
import { failGit } from '../../../test/support/fake-git.js';
import { hashDdevInputs } from './_ddev-inputs-hash.js';

const dirs: string[] = [];
let restore: (() => Promise<void>) | null = null;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ddev-hash-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'gc.auto', '0');
  await mkdir(path.join(dir, '.ddev', 'php'), { recursive: true });
  await writeFile(path.join(dir, '.ddev', 'config.yaml'), 'php_version: "8.3"\n');
  git('add', '.ddev/config.yaml');
  await writeFile(path.join(dir, '.ddev', 'php', 'extra.ini'), 'memory_limit=1G\n');
  return dir;
}

afterEach(async () => {
  await restore?.();
  restore = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('hashDdevInputs when git gave no answer', () => {
  it('rejects when ls-files ends with no exit status', async () => {
    const repo = await makeRepo();
    restore = (await killGit(['ls-files'])).restore;
    await expect(hashDdevInputs(repo)).rejects.toThrow(/gave no answer/);
  });

  it('hashes a healthy tree to the same 64-hex string twice', async () => {
    const repo = await makeRepo();
    const a = await hashDdevInputs(repo);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashDdevInputs(repo)).toBe(a);
  });

  it('returns null for a directory that is not a repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ddev-hash-plain-'));
    dirs.push(dir);
    expect(await hashDdevInputs(dir)).toBeNull();
  });

  it('returns null for a plain exit 128 from ls-files', async () => {
    const repo = await makeRepo();
    restore = (await failGit(['ls-files'])).restore;
    expect(await hashDdevInputs(repo)).toBeNull();
  });
});
