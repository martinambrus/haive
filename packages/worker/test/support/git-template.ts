import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Build once, then copy the whole tree (including .git) without sharing writable inodes.
 * Callers repair any absolute worktree/remote paths in their own known fixture layout.
 * Cleanup is registered at module scope, including lazily selected fixture variants. */
export function gitTemplate<T>(
  build: (dir: string) => Promise<T>,
  base: string = tmpdir(),
): { copy: () => Promise<{ dir: string; data: T }> } {
  let template: Promise<{ dir: string; data: T }> | undefined;
  return {
    async copy() {
      template ??= (async () => {
        const dir = await mkdtemp(path.join(base, 'git-template-'));
        roots.push(dir);
        return { dir, data: await build(dir) };
      })();
      const source = await template;
      const dir = await mkdtemp(path.join(base, 'git-copy-'));
      roots.push(dir);
      await exec('cp', ['-a', '--reflink=auto', `${source.dir}/.`, dir]);
      return { dir, data: source.data };
    },
  };
}
