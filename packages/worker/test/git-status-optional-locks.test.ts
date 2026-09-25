import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeCommitted } from '../src/step-engine/git-merge.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repository whose tracked file no longer matches the stat info in the index: the state in
 *  which a plain `git status` takes `index.lock` and rewrites `.git/index`. */
async function staleStatRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'haive-status-locks-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@test.local');
  git('config', 'user.name', 'Smoke');
  git('config', 'gc.auto', '0');
  await writeFile(path.join(dir, 'a.md'), 'a\n');
  git('add', 'a.md');
  git('commit', '-q', '-m', 'initial');
  const past = new Date(Date.now() - 3_600_000);
  await utimes(path.join(dir, 'a.md'), past, past);
  return dir;
}

const indexStamp = async (dir: string): Promise<string> => {
  const st = await stat(path.join(dir, '.git', 'index'));
  return `${st.ino}:${st.mtimeMs}`;
};

describe('a git status Haive runs', () => {
  it('leaves .git/index alone', async () => {
    const dir = await staleStatRepo();
    const before = await indexStamp(dir);
    expect(await mergeCommitted(dir, 'main')).toBe(true);
    expect(await indexStamp(dir)).toBe(before);
  });

  it('runs on a fixture a plain status does rewrite', async () => {
    const dir = await staleStatRepo();
    const before = await indexStamp(dir);
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'pipe' });
    expect(await indexStamp(dir)).not.toBe(before);
  });
});

describe('every git status argv', () => {
  it('carries --no-optional-locks', async () => {
    const packages = fileURLToPath(new URL('../..', import.meta.url));
    const offenders: string[] = [];
    for (const pkg of ['worker', 'api', 'shared']) {
      const src = path.join(packages, pkg, 'src');
      for (const rel of await readdir(src, { recursive: true })) {
        if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
        const text = await readFile(path.join(src, rel), 'utf8');
        // An array literal opening with 'status', never an index access such as Row['status'].
        for (const m of text.matchAll(/(?<![\w$)\]])\[\s*'status'/g)) {
          offenders.push(`${pkg}/src/${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
