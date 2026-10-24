import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killGit } from '../../../../test/support/kill-git.js';
import { hashDdevInputs } from '../_ddev-inputs-hash.js';
import { readDdevBaseline } from './01c-ddev-env.js';

const CONFIG = 'php_version: "8.3"\n';
const dirs: string[] = [];
let restore: (() => Promise<void>) | null = null;

async function makeDir(init: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ddev-base-'));
  dirs.push(dir);
  if (init) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'gc.auto', '0');
  }
  await mkdir(path.join(dir, '.ddev', 'php'), { recursive: true });
  await writeFile(path.join(dir, '.ddev', 'config.yaml'), CONFIG);
  await writeFile(path.join(dir, '.ddev', 'php', 'extra.ini'), 'memory_limit=1G\n');
  return dir;
}

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) as never;

afterEach(async () => {
  await restore?.();
  restore = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('readDdevBaseline when the .ddev/ listing gave no answer', () => {
  it('records no baseline and warns', async () => {
    const repo = await makeDir(true);
    const logger = makeLogger();
    restore = (await killGit(['ls-files'])).restore;
    expect(await readDdevBaseline(repo, logger)).toBeNull();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
  });

  it('hashes a healthy tree as hashDdevInputs does', async () => {
    const repo = await makeDir(true);
    const base = await readDdevBaseline(repo, makeLogger());
    expect(base?.phpVersion).toBe('8.3');
    expect(base?.configHash).toBe(await hashDdevInputs(repo));
  });

  it('keeps the config.yaml hash for a directory that is not a repository', async () => {
    const repo = await makeDir(false);
    const base = await readDdevBaseline(repo, makeLogger());
    expect(base?.configHash).toBe(createHash('sha256').update(CONFIG).digest('hex'));
  });
});
