import { fixtureBase, networkGitArgs, httpOrigin } from './support/git-http.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { schema } from '@haive/database';
import type { Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { gitClone } from '../src/repo/clone.js';
import { gitTimeoutLimits } from '../src/repo/git-exec.js';
import { gitRevParseHead, handleResyncGit } from '../src/repo/bundle-ingest.js';
import { runBundleGitSyncTick } from '../src/repo/bundle-sync.js';
import { failGit } from './support/fake-git.js';
import { shimGit } from './support/shim-git.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const BUNDLE = '00000000-0000-4000-8000-0000000000b3';
const REPOSITORY = '00000000-0000-4000-8000-0000000000c1';
const LEAK = "fatal: unable to access 'https://user:s3cret@example.com/r.git/': boom";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'gc.auto=0',
      ...networkGitArgs(args),
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();

let tmpRoot: string;
let restore: (() => Promise<void>) | null = null;
const saved = { ...gitTimeoutLimits };

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(fixtureBase, 'bundle-git-bound-'));
});

afterEach(async () => {
  if (restore) await restore();
  restore = null;
  gitTimeoutLimits.long = saved.long;
  gitTimeoutLimits.short = saved.short;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function makeOriginAndClone(): Promise<{ origin: string; extracted: string }> {
  const origin = path.join(tmpRoot, 'origin.git');
  const work = path.join(tmpRoot, 'work');
  git(tmpRoot, 'init', '--bare', '--initial-branch=main', origin);
  await mkdir(work, { recursive: true });
  git(work, 'init', '--initial-branch=main');
  git(work, 'remote', 'add', 'origin', origin);
  await writeFile(path.join(work, 'a.txt'), 'one');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'one');
  git(work, 'push', 'origin', 'main');
  const extracted = path.join(tmpRoot, USER, BUNDLE, 'extracted');
  await gitClone(httpOrigin(origin), extracted, 'main');
  git(extracted, 'config', 'gc.auto', '0');
  return { origin, extracted };
}

function bundleDb(origin: string, storageRoot: string) {
  const fake = createFakeDb({ customBundles: schema.customBundles });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPOSITORY,
    name: 'bundle',
    sourceType: 'git',
    status: 'active',
    gitUrl: httpOrigin(origin),
    gitBranch: 'main',
    storageRoot,
  });
  return fake;
}

const resync = (fake: ReturnType<typeof bundleDb>) =>
  handleResyncGit(
    { bundleId: BUNDLE, userId: USER } as never,
    fake.db as unknown as Database,
    tmpRoot,
  );

describe('bundle git calls are bounded', () => {
  it('gitRevParseHead gives up on a rev-parse that hangs', async () => {
    const { extracted } = await makeOriginAndClone();
    gitTimeoutLimits.short = 300;
    restore = (await failGit(['rev-parse', 'HEAD'], { hang: true })).restore;
    await expect(gitRevParseHead(extracted)).rejects.toThrow(/git rev-parse failed \(exit 124\)/);
  }, 10_000);

  it('handleResyncGit gives up on a pull that hangs and records it', async () => {
    const { origin } = await makeOriginAndClone();
    const fake = bundleDb(origin, '');
    gitTimeoutLimits.long = 300;
    restore = (await failGit(['pull'], { hang: true })).restore;
    await expect(resync(fake)).rejects.toThrow(/git pull failed \(exit 124\)/);
    const row = fake.rows(schema.customBundles)[0];
    expect(row?.status).toBe('failed');
    expect(row?.lastSyncError).toContain('timed out');
  }, 10_000);

  it('runBundleGitSyncTick counts a fetch that hangs as one error', async () => {
    const { origin, extracted } = await makeOriginAndClone();
    const fake = bundleDb(origin, extracted);
    gitTimeoutLimits.long = 300;
    restore = (await failGit(['fetch'], { hang: true })).restore;
    expect(await runBundleGitSyncTick(fake.db as unknown as Database)).toEqual({
      scanned: 1,
      updated: 0,
      errors: 1,
    });
  }, 10_000);
});

describe('bundle git credentials and environment', () => {
  it('scrubs a url from a failed pull', async () => {
    const { origin } = await makeOriginAndClone();
    const fake = bundleDb(origin, '');
    restore = (
      await shimGit(
        `if [ "$SUB" = pull ]; then echo "${LEAK}" >&2; exit 128; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    await expect(resync(fake)).rejects.toThrow(/git pull failed \(exit 128\)/);
    const err = String(fake.rows(schema.customBundles)[0]?.lastSyncError);
    expect(err).toContain('https://example.com/');
    expect(err).not.toContain('s3cret');
  }, 10_000);

  it('runs the pull without interactive prompting', async () => {
    const { origin } = await makeOriginAndClone();
    const fake = bundleDb(origin, '');
    const seen = path.join(tmpRoot, 'seen');
    restore = (
      await shimGit(
        `if [ "$SUB" = pull ]; then echo "$GIT_ASKPASS $GIT_TERMINAL_PROMPT" >> '${seen}'; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    await resync(fake).catch(() => undefined);
    expect((await readFile(seen, 'utf8')).trim()).toBe('echo 0');
  }, 10_000);

  it('runs the tick fetch without interactive prompting', async () => {
    const { origin, extracted } = await makeOriginAndClone();
    const seen = path.join(tmpRoot, 'seen');
    restore = (
      await shimGit(
        `if [ "$SUB" = fetch ]; then echo "$GIT_ASKPASS $GIT_TERMINAL_PROMPT" >> '${seen}'; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    await runBundleGitSyncTick(bundleDb(origin, extracted).db as unknown as Database);
    expect((await readFile(seen, 'utf8')).trim()).toBe('echo 0');
  }, 10_000);

  it('scrubs a url from a failed tick fetch', async () => {
    const { origin, extracted } = await makeOriginAndClone();
    const warned: unknown[] = [];
    const child = vi.spyOn(logger, 'child').mockReturnValue({
      debug: () => undefined,
      info: () => undefined,
      warn: (obj: unknown) => warned.push(obj),
    } as never);
    restore = (
      await shimGit(
        `if [ "$SUB" = fetch ]; then echo "${LEAK}" >&2; exit 128; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    try {
      const out = await runBundleGitSyncTick(bundleDb(origin, extracted).db as unknown as Database);
      expect(out.errors).toBe(1);
    } finally {
      child.mockRestore();
    }
    const msg = String((warned[0] as { err: Error }).err.message);
    expect(msg).toMatch(/git fetch failed \(exit 128\)/);
    expect(msg).toContain('https://example.com/');
    expect(msg).not.toContain('s3cret');
  }, 10_000);
});
