import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { RepoJobPayload } from '@haive/shared';
import { gitTemplate } from './support/git-template.js';

const h = vi.hoisted(() => ({
  persist: vi.fn(),
  build: null as null | ((source: string, dest: string) => Promise<void>),
  clone: vi.fn(),
  cleanupFails: false,
  asideReplyFails: false,
}));
vi.mock('../src/repo/clone.js', async (original) => {
  const real = await original<typeof import('../src/repo/clone.js')>();
  return {
    ...real,
    withRootClaim: (_db: unknown, _id: string, run: () => Promise<void>) => run(),
    persistDetection: h.persist,
    copyTree: (source: string, dest: string) =>
      h.build ? h.build(source, dest) : real.copyTree(source, dest),
    gitClone: h.clone,
  };
});
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: async () => {},
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    renameNoFollow: async (...args: Parameters<typeof real.renameNoFollow>) => {
      await real.renameNoFollow(...args);
      if (h.asideReplyFails && args[2].includes('.aside-'))
        throw new Error('simulated lost aside rename reply');
    },
    removeNoFollow: (...args: Parameters<typeof real.removeNoFollow>) => {
      if (h.cleanupFails && args[1].includes('.rebuild-'))
        throw new Error('simulated cleanup refusal');
      return real.removeNoFollow(...args);
    },
  };
});
import { handleRefresh } from './support/repo-preparation.js';
import { handleRefresh as ownedRefresh, usableCheckout } from '../src/repo/refresh.js';
import { withRepoJobOwner } from '../src/repo/job-owner.js';

const exec = promisify(execFile);
const REPO = '00000000-0000-4000-8000-000000000001';
const oldName = `${REPO}.aside-2026-01-01T00-00-00-000Z`;
const template = gitTemplate(async (dir) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@local',
  };
  await exec('git', ['init', '-b', 'main'], { cwd: dir, env });
  await writeFile(path.join(dir, 'complete.txt'), 'complete replacement\n');
  await exec('git', ['add', '.'], { cwd: dir, env });
  await exec('git', ['commit', '-m', 'source'], { cwd: dir, env });
});
let root: string;
let source: string;
let dest: string;
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
const payload = (kind: 'copy' | 'clone'): RepoJobPayload => ({
  repositoryId: REPO,
  userId: 'u1',
  branch: 'main',
  ...(kind === 'copy'
    ? { source: 'local_path', localPath: source }
    : {
        source: 'git_https',
        remoteUrl: 'https://git.example.test/r1.git',
      }),
});
const row = () => fake.rows(schema.repositories)[0]!;
const asides = async () =>
  (await readdir(path.dirname(dest))).filter((name) => name.startsWith(`${REPO}.aside-`)).sort();
beforeEach(async () => {
  vi.clearAllMocks();
  h.build = null;
  h.cleanupFails = false;
  h.asideReplyFails = false;
  root = await mkdtemp(path.join(tmpdir(), 'refresh-asides-'));
  source = (await template.copy()).dir;
  dest = path.join(root, 'u1', REPO);
  await mkdir(path.dirname(dest));
  await cp(source, dest, { recursive: true });
  await writeFile(path.join(dest, 'private.txt'), 'original unpushed work\n');
  await rm(path.join(dest, '.git/HEAD'));
  fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  db = fake.db as unknown as Database;
  fake.insert(schema.repositories, { id: REPO, status: 'cloning' });
  h.clone.mockImplementation((_url, to) => cp(source, to, { recursive: true }));
  h.persist.mockImplementation(async (_db, _id, _to, note) => {
    fake.patch(schema.repositories, REPO, { status: 'ready', statusMessage: note });
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('T486 retained checkout controls on real temporary trees', () => {
  it.each(['copy', 'clone'] as const)(
    'member 2: a failed %s already names the first aside',
    async (kind) => {
      const fail = async (_source: string, to: string) => {
        await mkdir(to, { recursive: true });
        await writeFile(path.join(to, 'partial.txt'), 'interrupted');
        throw new Error('simulated build failure');
      };
      if (kind === 'copy') h.build = fail;
      else h.clone.mockImplementation(fail);
      const error = await handleRefresh(payload(kind), db, root, async () => () => {}).catch(
        (err: Error) => err,
      );
      expect(error).toBeInstanceOf(Error);
      const kept = await asides();
      expect(kept).toHaveLength(1);
      expect((error as Error).message).toContain(kept[0]);
      expect(row().checkoutAsidePaths).toEqual(kept);
      expect(error).toMatchObject({ checkoutAsidePaths: kept });
      expect(await readFile(path.join(path.dirname(dest), kept[0]!, 'private.txt'), 'utf8')).toBe(
        'original unpushed work\n',
      );
    },
  );

  it.each(['copy', 'clone'] as const)(
    'member 4: interrupted %s never exposes completed .git with missing files',
    async (kind) => {
      let publicState: Awaited<ReturnType<typeof usableCheckout>> | undefined;
      const interrupt = async (_source: string, to: string) => {
        await mkdir(to, { recursive: true });
        await cp(path.join(source, '.git'), path.join(to, '.git'), { recursive: true });
        publicState = await usableCheckout(dest);
        throw new Error('simulated death after copying .git');
      };
      h.cleanupFails = true; // Leave the interrupted build for the next attempt, as a process death does.
      if (kind === 'copy') h.build = interrupt;
      else h.clone.mockImplementation(interrupt);
      await expect(handleRefresh(payload(kind), db, root, async () => () => {})).rejects.toThrow(
        'simulated death',
      );
      expect(publicState).toBe('unusable');
      expect(await usableCheckout(dest)).toBe('unusable');
      h.build = null;
      h.clone.mockImplementation((_url, to) => cp(source, to, { recursive: true }));
      await handleRefresh(payload(kind), db, root, async () => () => {});
      expect(await readFile(path.join(dest, 'complete.txt'), 'utf8')).toBe(
        'complete replacement\n',
      );
      expect(await asides()).toHaveLength(1);
      expect(row().statusMessage).toContain((await asides())[0]);
    },
  );

  it('members 4/2: a later failed rebuild names every aside, including an older process death', async () => {
    await rename(dest, path.join(path.dirname(dest), oldName));
    await mkdir(dest);
    await writeFile(path.join(dest, 'partial.txt'), 'earlier incomplete clone');
    h.clone.mockRejectedValue(new Error('second build failed'));
    const error = await handleRefresh(payload('clone'), db, root, async () => () => {}).catch(
      (err: Error) => err,
    );
    const kept = await asides();
    expect(kept).toHaveLength(2);
    for (const name of kept) expect((error as Error).message).toContain(name);
    expect(row().checkoutAsidePaths).toEqual(kept);
    expect(error).toMatchObject({ checkoutAsidePaths: kept });
  });

  it('a successful retry reports both old trees and undo can restore the original work', async () => {
    await rename(dest, path.join(path.dirname(dest), oldName));
    await mkdir(dest);
    await writeFile(path.join(dest, 'partial.txt'), 'earlier incomplete clone');
    await handleRefresh(payload('clone'), db, root, async () => () => {});
    const kept = await asides();
    expect(kept).toHaveLength(2);
    expect(row().checkoutAsidePaths).toEqual(kept);
    for (const name of kept) expect(row().statusMessage).toContain(name);
    // Manual undo retains the replacement too; nothing removes either preserved tree.
    await rename(dest, path.join(root, 'replacement-kept'));
    await rename(path.join(path.dirname(dest), oldName), dest);
    expect(await readFile(path.join(dest, 'private.txt'), 'utf8')).toBe('original unpushed work\n');
  });

  it('aside discovery ignores other repositories and names the worker never generated', async () => {
    await mkdir(path.join(path.dirname(dest), `${REPO}.aside-lookalike`));
    await mkdir(path.join(path.dirname(dest), `another.aside-2026-01-01T00-00-00-000Z`));
    await handleRefresh(payload('copy'), db, root, async () => () => {});
    expect(row().checkoutAsidePaths).toEqual(
      (await asides()).filter((name) => name !== `${REPO}.aside-lookalike`),
    );
    expect(row().statusMessage).not.toContain('lookalike');
    expect(row().statusMessage).not.toContain('another.aside');
  });

  it('omits an empty rename claim from the notice and column without removing it', async () => {
    const emptyClaim = path.join(path.dirname(dest), oldName);
    await mkdir(emptyClaim);
    await handleRefresh(payload('copy'), db, root, async () => () => {});
    const kept = (await asides()).filter((name) => name !== oldName);
    expect(kept).toHaveLength(1);
    expect(row().checkoutAsidePaths).toEqual(kept);
    expect(row().statusMessage).not.toContain(oldName);
    expect(await readdir(emptyClaim)).toEqual([]);
  });

  it('still names the old tree when a completed aside rename throws', async () => {
    h.asideReplyFails = true;
    const error = await handleRefresh(payload('copy'), db, root, async () => () => {}).catch(
      (err: Error) => err,
    );
    const kept = await asides();
    expect(kept).toHaveLength(1);
    expect(error).toMatchObject({ checkoutAsidePaths: kept });
    expect((error as Error).message).toContain(kept[0]);
    expect(row().checkoutAsidePaths).toEqual(kept);
    expect(await readFile(path.join(path.dirname(dest), kept[0]!, 'private.txt'), 'utf8')).toBe(
      'original unpushed work\n',
    );
  });

  it.each([false, true])(
    'a later ordinary refresh clears the rebuild notice while retaining the inventory (holder=%s)',
    async (holding) => {
      await handleRefresh(payload('copy'), db, root, async () => () => {});
      const kept = await asides();
      expect(row().statusMessage).toContain(kept[0]);
      if (holding)
        fake.insert(schema.tasks, { repositoryId: REPO, status: 'running', deadAt: null });
      await handleRefresh(payload('copy'), db, root, async () => () => {});
      if (holding) {
        expect(row().statusMessage).toContain('Not refreshed:');
        expect(row().statusMessage).not.toContain(kept[0]);
      } else expect(row().statusMessage).toBeNull();
      expect(row().checkoutAsidePaths).toEqual(kept);
    },
  );

  it('an unrelated ordinary refresh failure does not revive an old rebuild notice', async () => {
    await handleRefresh(payload('copy'), db, root, async () => () => {});
    const kept = await asides();
    // A corrupt config is unknown, rather than proof authorizing another rebuild.
    await writeFile(path.join(dest, '.git/config'), '[invalid');
    const error = await handleRefresh(payload('copy'), db, root, async () => () => {}).catch(
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(kept[0]);
    expect(row().checkoutAsidePaths).toEqual(kept);
  });

  it('uses singular file ownership when reporting one aside', async () => {
    await handleRefresh(payload('copy'), db, root, async () => () => {});
    expect(row().statusMessage).toMatch(/\. Its files and unpushed commits are retained there\.$/);
  });

  it.each([
    [null, true, 'no_owner_on_row'],
    ['another-job', true, 'different_owner'],
    ['current-job', false, 'not_pending'],
  ])(
    'diagnoses an obsolete job before recording asides (%s, %s)',
    async (jobId, pending, reason) => {
      fake.patch(schema.repositories, REPO, {
        refreshJobId: jobId,
        refreshPending: pending,
        checkoutAsidePaths: ['existing-evidence'],
      });
      await expect(
        withRepoJobOwner(REPO, 'current-job', () =>
          ownedRefresh(payload('copy'), db, root, async () => () => {}),
        ),
      ).rejects.toMatchObject({ reason });
      expect(row().checkoutAsidePaths).toEqual(['existing-evidence']);
      expect(await asides()).toEqual([]);
    },
  );

  it.each([false, true])(
    'member 6: a retry after persistDetection throws retains aside names (holder=%s)',
    async (holding) => {
      // Redelivery belongs to the same pending admission; a new ordinary refresh does not.
      const jobId = 'rebuild-job';
      fake.patch(schema.repositories, REPO, { refreshJobId: jobId, refreshPending: true });
      const retry = () =>
        withRepoJobOwner(REPO, jobId, () =>
          ownedRefresh(payload('copy'), db, root, async () => () => {}),
        );
      h.persist.mockImplementationOnce(async (_db, _id, _to, note) => {
        fake.patch(schema.repositories, REPO, { status: 'ready', statusMessage: note });
        throw new Error('persistDetection failed after publication');
      });
      await expect(retry()).rejects.toThrow('persistDetection failed');
      const kept = await asides();
      expect(kept).toHaveLength(1);
      expect(row().statusMessage).toContain(kept[0]);
      fake.patch(schema.repositories, REPO, { status: 'error', statusMessage: 'retry pending' });
      if (holding)
        fake.insert(schema.tasks, { repositoryId: REPO, status: 'running', deadAt: null });
      await retry();
      expect(row().status).toBe('ready');
      expect(row().statusMessage).toContain(kept[0]);
      expect(await asides()).toEqual(kept);
    },
  );
});
