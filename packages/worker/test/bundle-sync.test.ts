import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { gitClone } from '../src/repo/clone.js';
import { gitRevParseHead } from '../src/repo/bundle-ingest.js';

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@haive.local',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@haive.local',
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-bundle-sync-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Set up a bare upstream + working clone, then push a second commit to the
 *  bare repo. Returns paths and the two commit SHAs (initial + advanced). */
async function setupBareWithAdvance(): Promise<{
  cloneDir: string;
  initialCommit: string;
  advancedCommit: string;
}> {
  const bare = path.join(tmpRoot, 'origin.git');
  await run('git', ['init', '--bare', '--initial-branch=main', bare]);

  // Author repo, push initial commit to bare.
  const author = path.join(tmpRoot, 'author');
  await mkdir(author, { recursive: true });
  await run('git', ['init', '--initial-branch=main', author]);
  await writeFile(path.join(author, 'README.md'), 'first\n');
  await run('git', ['add', 'README.md'], author);
  await run('git', ['commit', '-m', 'initial'], author);
  await run('git', ['remote', 'add', 'origin', bare], author);
  await run('git', ['push', 'origin', 'main'], author);
  const initialCommit = await run('git', ['rev-parse', 'HEAD'], author);

  // Independent bundle clone (this is what bundle-sync.ts operates on).
  const cloneDir = path.join(tmpRoot, 'clone');
  await gitClone(bare, cloneDir, 'main');

  // Author advances upstream — bundle clone is now stale.
  await writeFile(path.join(author, 'README.md'), 'second\n');
  await run('git', ['add', 'README.md'], author);
  await run('git', ['commit', '-m', 'advance'], author);
  await run('git', ['push', 'origin', 'main'], author);
  const advancedCommit = await run('git', ['rev-parse', 'HEAD'], author);

  return { cloneDir, initialCommit, advancedCommit };
}

/** runBundleGitSyncTick depends on a Database, but its read-only contract is
 *  that `git fetch` updates the remote-tracking ref while leaving the
 *  working tree's HEAD untouched. This test isolates that contract by
 *  invoking the same git ops at the spawn level — proving an upstream
 *  advance becomes visible via `git rev-parse origin/main` without changing
 *  what `git rev-parse HEAD` reports inside the clone. */
describe('bundle git fetch contract (drives upgrade-status drift)', () => {
  it('updates origin/main after fetch but leaves clone HEAD untouched', async () => {
    const { cloneDir, initialCommit, advancedCommit } = await setupBareWithAdvance();

    // Before fetch: clone HEAD == initial; no remote-tracking divergence yet.
    const headBefore = await gitRevParseHead(cloneDir);
    expect(headBefore).toBe(initialCommit);

    // Fetch only — no checkout, no pull.
    await run('git', ['fetch', '--quiet', 'origin', 'main'], cloneDir);

    // Working tree HEAD must NOT have moved. This is the property the daily
    // sync tick relies on: it is safe to run unattended without breaking
    // user state.
    const headAfter = await gitRevParseHead(cloneDir);
    expect(headAfter).toBe(initialCommit);

    // Remote-tracking ref now reports the advanced commit.
    const remoteHead = await run('git', ['rev-parse', 'origin/main'], cloneDir);
    expect(remoteHead).toBe(advancedCommit);
    expect(remoteHead).not.toBe(headAfter);
  });
});
