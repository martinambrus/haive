import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRun } from './git-exec.js';
import { ensureOrigin } from './git-push.js';
import { failGit, type FakeGit } from '../../test/support/fake-git.js';
const dirs: string[] = [];
const shims: FakeGit[] = [];
afterEach(async () => {
  for (const shim of shims.splice(0)) await shim.restore();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function repo(): Promise<string> {
  const dir = await mkdtemp('/tmp/t388-ensure-');
  dirs.push(dir);
  await gitRun(dir, ['init']);
  return dir;
}
describe('ensureOrigin exit codes', () => {
  it('recognizes already-exists by exit 3 even with different stderr', async () => {
    const work = await repo();
    await gitRun(work, ['remote', 'add', 'origin', 'https://example.test/old']);
    shims.push(await failGit(['remote', 'add'], { exit: 3 }));
    expect(await ensureOrigin(work, 'https://example.test/new')).toEqual({
      added: false,
      updated: true,
    });
  });
  it('fails when set-url fails', async () => {
    const work = await repo();
    await gitRun(work, ['remote', 'add', 'origin', 'https://example.test/old']);
    shims.push(await failGit(['remote', 'set-url']));
    await expect(ensureOrigin(work, 'https://example.test/new')).rejects.toThrow(/set-url/);
  });
});
