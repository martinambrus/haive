import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REPO_JOB_NAMES } from '@haive/shared';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { schema } from '@haive/database';
import { restoreFaults } from '../src/project-state/set-aside.js';
import * as projections from '../src/project-state/set-aside.js';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';
import { failGit, type FakeGit } from './support/fake-git.js';
import { killGit } from './support/kill-git.js';

const h = vi.hoisted(() => ({
  persist: vi.fn(),
  seed: vi.fn(),
  helper: vi.fn(),
  clone: vi.fn(),
  /** Stands in for the copy that follows the move; null runs the real one. */
  copyFault: null as null | ((src: string, dest: string) => Promise<void>),
  holding: 0,
  processor: null as Processor | null,
}));
vi.mock('../src/repo/clone.js', async (original) => {
  const real = await original<typeof import('../src/repo/clone.js')>();
  return {
    ...real,
    withRootClaim: async (_db: unknown, _id: string, fn: () => Promise<void>) => fn(),
    persistDetection: h.persist,
    gitClone: h.clone,
    copyTree: (src: string, dest: string) =>
      h.copyFault ? h.copyFault(src, dest) : real.copyTree(src, dest),
  };
});
vi.mock('../src/repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-push.js')>()),
  buildCredentialHelper: h.helper,
}));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: h.seed,
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: Processor) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
import { startRepoWorker } from '../src/queues/repo-queue.js';
import { handleRefresh, usableCheckout } from '../src/repo/refresh.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@local',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@local',
      },
    })
  ).stdout.trim();
let root: string;
let shim: FakeGit | null = null;
const row: { status: string; statusMessage?: string } = { status: 'ready' };
const db = {
  execute: async () => {},
  query: {
    tasks: { findMany: async () => Array.from({ length: h.holding }, () => ({ id: 'holder' })) },
  },
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({ limit: async () => (table === schema.planNodes ? [{ id: 'node' }] : []) }),
    }),
  }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  update: () => ({ set: (values: object) => ({ where: async () => Object.assign(row, values) }) }),
} as unknown as Database;
beforeEach(async () => {
  vi.clearAllMocks();
  row.status = 'cloning';
  h.holding = 0;
  h.copyFault = null;
  h.seed.mockResolvedValue(undefined);
  delete row.statusMessage;
  h.persist.mockImplementation(async (_db, _id, _dest, note) => {
    row.status = 'ready';
    row.statusMessage = note;
  });
  root = await mkdtemp(path.join(tmpdir(), 'refresh-operation-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete restoreFaults.afterRestore;
  delete restoreFaults.beforePutBack;
  await shim?.restore();
  shim = null;
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const source = path.join(root, 'source');
  const dest = path.join(root, 'u1', 'r1');
  await mkdir(source);
  await mkdir(path.dirname(dest));
  await git(source, ['init', '-b', 'main']);
  await git(source, ['commit', '--allow-empty', '-m', 'one']);
  await git(root, ['clone', source, dest]);
  await git(source, ['commit', '--allow-empty', '-m', 'two']);
  await mkdir(path.join(dest, '.haive-data'));
  await writeFile(path.join(dest, '.haive-data/plan.md'), 'pending\n');
  return {
    dest,
    payload: {
      source: 'local_path',
      localPath: source,
      userId: 'u1',
      repositoryId: 'r1',
    } as RepoJobPayload,
  };
}
it.each(['failed git-path', 'external git-dir'])(
  'refresh refuses an unreadable operation: %s',
  async (kind) => {
    const { dest, payload } = await fixture();
    const before = await git(dest, ['rev-parse', 'HEAD']);
    if (kind === 'failed git-path') shim = await failGit(['rev-parse', '--git-path']);
    else {
      const gitDir = path.join(root, 'outside.git');
      await rename(path.join(dest, '.git'), gitDir);
      await writeFile(path.join(dest, '.git'), `gitdir: ${gitDir}\n`);
    }
    await handleRefresh(payload, db, root);
    expect(row.status).toBe('ready');
    expect(row.statusMessage).toMatch(
      /^Not refreshed: .*could not be checked for an open merge or rebase .*The checkout was not moved\.$/,
    );
    await shim?.restore();
    shim = null;
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
  },
);

it('an unknown checkout fails through the queue without detection, import or rebuild', async () => {
  const { dest, payload } = await fixture();
  const before = await git(dest, ['rev-parse', 'HEAD']);
  shim = await failGit(['rev-parse', '--show-cdup']);
  await expect(runRefresh(payload)).rejects.toThrow(
    /^Not refreshed: the checkout could not be examined \(.*\)\. Nothing was moved\. Retry cannot help until the checkout is repaired\. Removing the repository deletes this checkout, including any commit that was never pushed\.$/,
  );
  expect(h.persist).not.toHaveBeenCalled();
  expect(h.seed).not.toHaveBeenCalled();
  expect(row.status).toBe('error');
  expect(row.statusMessage).toMatch(/^Not refreshed: the checkout could not be examined \(/);
  await shim.restore();
  shim = null;
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
  expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
});

it('a git read that never finished does not tell the user to repair the checkout', async () => {
  const { dest, payload } = await fixture();
  shim = await killGit(['rev-parse', '--show-cdup']);
  await expect(runRefresh(payload)).rejects.toThrow(
    /^Not refreshed: the checkout could not be examined \(.*SIGKILL.*\)\. Nothing was moved\.$/,
  );
  expect(row.status).toBe('error');
  expect(row.statusMessage).not.toContain('Retry cannot help');
  await shim.restore();
  shim = null;
  expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
});

async function runRefresh(payload: RepoJobPayload) {
  startRepoWorker(root);
  return h.processor!({ name: REPO_JOB_NAMES.REFRESH, data: payload } as Job);
}

it.each(['usable', 'unusable', 'unknown', 'holding', 'refused'] as const)(
  'refresh %s reaches a terminal repository status',
  async (kind) => {
    const { dest, payload } = await fixture();
    if (kind === 'usable') await git(payload.localPath!, ['reset', '--hard', 'HEAD^']);
    if (kind === 'unusable') await rm(path.join(dest, '.git'), { recursive: true });
    if (kind === 'unknown') shim = await failGit(['rev-parse', '--show-cdup']);
    if (kind === 'holding') h.holding = 1;
    if (kind === 'refused') await git(dest, ['checkout', '--detach']);
    await runRefresh(payload).catch(() => undefined);
    expect(row.status).toBe(kind === 'unknown' ? 'error' : 'ready');
    expect(['ready', 'error']).toContain(row.status);
  },
);
it.each([false, true])(
  'later unreadable gate puts pending bytes and index back (put-back fails: %s)',
  async (failedPutBack) => {
    const { dest, payload } = await fixture();
    const file = '.haive-data/plan.md';
    await git(dest, ['add', '--', file]);
    const staged = await git(dest, ['ls-files', '-s', '--', file]);
    const before = await git(dest, ['rev-parse', 'HEAD']);
    let restored = 0;
    restoreFaults.afterRestore = async () => {
      restored++;
      expect(await readFile(path.join(dest, file), 'utf8').catch(() => null)).toBeNull();
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe('');
      // A sweep leaves another pending file after capture. The next pre-move gate must put back the captured one.
      await writeFile(path.join(dest, '.haive-data/plan.json'), '{}\n');
      shim = await failGit(['rev-parse', '--git-path']);
    };
    const putError = new Error('put-back fault');
    if (failedPutBack)
      restoreFaults.beforePutBack = () => {
        throw putError;
      };
    if (failedPutBack) {
      const err = await handleRefresh(payload, db, root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toContain(putError);
      expect((err as AggregateError).errors[0]).toHaveProperty(
        'name',
        'GitOperationUnreadableError',
      );
    } else {
      await handleRefresh(payload, db, root);
      expect(row.statusMessage).toMatch(/could not be checked.*The checkout was not moved/);
      expect(await readFile(path.join(dest, file), 'utf8')).toBe('pending\n');
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe(staged);
    }
    expect(restored).toBe(1);
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
  },
);

it.each(['.git/HEAD', '.git/objects'])(
  'refresh keeps a checkout with no %s aside and copies a usable replacement',
  async (missing) => {
    const { dest, payload } = await fixture();
    await rm(path.join(dest, missing), { recursive: true });
    await runRefresh(payload);
    const aside = (await readdir(path.dirname(dest))).find((entry) =>
      entry.startsWith('r1.aside-'),
    );
    expect(aside).toBeTruthy();
    expect(
      await readFile(path.join(path.dirname(dest), aside!, '.haive-data/plan.md'), 'utf8'),
    ).toBe('pending\n');
    await expect(readFile(path.join(path.dirname(dest), aside!, missing))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(
      await git(payload.localPath!, ['rev-parse', 'HEAD']),
    );
    expect(row.status).toBe('ready');
    expect(row.statusMessage).toContain(aside);
  },
);

/** A remote-sourced payload for the same repository the fixture cloned from a folder. */
const remotePayload = {
  source: 'git_https',
  remoteUrl: 'https://git.example.test/r1.git',
  credentialsId: 'cred-1',
  branch: 'main',
  userId: 'u1',
  repositoryId: 'r1',
} as RepoJobPayload;

async function untouched(dest: string): Promise<void> {
  expect(await readdir(path.dirname(dest))).toEqual(['r1']);
  expect(await readFile(path.join(dest, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
  expect(h.persist).not.toHaveBeenCalled();
}

it('a credential that cannot be built leaves the unusable checkout where it was', async () => {
  const { dest } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  h.helper.mockRejectedValueOnce(new Error('the stored credential could not be read'));
  const err = await handleRefresh(remotePayload, db, root).catch((e: unknown) => e);
  await untouched(dest);
  expect(h.clone).not.toHaveBeenCalled();
  expect((err as Error).message).toBe('the stored credential could not be read');
});

it('a source folder that is gone leaves the unusable checkout where it was', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  await rm(payload.localPath!, { recursive: true });
  const err = await handleRefresh(payload, db, root).catch((e: unknown) => e);
  await untouched(dest);
  expect((err as Error).message).toBe(
    `Not refreshed: the folder this repository was imported from (${payload.localPath}) is gone. Nothing was moved.`,
  );
});

const gitfile = (text: string | Buffer) => async (dir: string) => {
  await rm(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git'), text);
};
/** The ways a `.git` stops being what git requires that refresh-usable-checkout.test.ts reads as
 *  unusable, applied here to the folder a repository was imported from. */
const deadGit: Array<[string, (dir: string) => Promise<void>]> = [
  ['no .git', (dir) => rm(path.join(dir, '.git'), { recursive: true })],
  ['no HEAD', (dir) => rm(path.join(dir, '.git/HEAD'))],
  [
    'an empty .git directory',
    async (dir) => {
      await rm(path.join(dir, '.git'), { recursive: true });
      await mkdir(path.join(dir, '.git'));
    },
  ],
  ['no objects/', (dir) => rm(path.join(dir, '.git/objects'), { recursive: true })],
  ['no refs/', (dir) => rm(path.join(dir, '.git/refs'), { recursive: true })],
  ['an empty HEAD', (dir) => writeFile(path.join(dir, '.git/HEAD'), '')],
  ['a zero-filled HEAD', (dir) => writeFile(path.join(dir, '.git/HEAD'), Buffer.alloc(21))],
  [
    'a HEAD of 39 hex digits',
    async (dir) => {
      const oid = await git(dir, ['rev-parse', 'HEAD']);
      await writeFile(path.join(dir, '.git/HEAD'), `${oid.slice(0, 39)}\n`);
    },
  ],
  [
    'a HEAD that is neither a ref nor an object id',
    (dir) => writeFile(path.join(dir, '.git/HEAD'), 'garbage\n'),
  ],
  ['an empty .git file', gitfile('')],
  ['a .git file that is not a gitfile', gitfile('garbage\n')],
  ['a .git file with no space after gitdir:', gitfile('gitdir:meta.git\n')],
  [
    'a .git file behind a byte-order mark',
    gitfile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('gitdir: meta.git\n')])),
  ],
  ['a .git file naming a missing relative gitdir', gitfile('gitdir: missing.git\n')],
  [
    'a .git file naming a missing absolute gitdir',
    (dir) => gitfile(`gitdir: ${path.join(dir, 'missing.git')}\n`)(dir),
  ],
];

it.each(deadGit)(
  'a source folder with %s is refused before anything moves, however often it is refreshed',
  async (_shape, breakGit) => {
    const { dest, payload } = await fixture();
    await rm(path.join(dest, '.git/HEAD'));
    await breakGit(payload.localPath!);
    // The control means something only while both the checkout and its source read as dead.
    expect(await usableCheckout(dest)).toBe('unusable');
    expect(await usableCheckout(payload.localPath!)).toBe('unusable');
    for (let refresh = 1; refresh <= 3; refresh++) {
      await expect(runRefresh(payload)).rejects.toThrow(
        /^Not refreshed: the folder this repository was imported from \(.*\) is not a usable git checkout\. Nothing was moved\.$/,
      );
      expect(row.status).toBe('error');
      expect(row.statusMessage).toMatch(/is not a usable git checkout\. Nothing was moved\.$/);
      await untouched(dest);
    }
  },
);

it('a source folder git gave no answer in is refused with that, and without repair advice', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  // The first --show-cdup read is the checkout's own; the second is the folder's.
  shim = await killGit(['rev-parse', '--show-cdup'], { after: 1 });
  await expect(runRefresh(payload)).rejects.toThrow(
    /^Not refreshed: the folder this repository was imported from \(.*\) could not be examined \(.*SIGKILL.*\)\. Nothing was moved\.$/,
  );
  expect(row.status).toBe('error');
  await untouched(dest);
});

it('a source folder git exited over without proof it is dead is refused with the repair advice', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  // A link standing where .git should be: no structural read can call it dead, and git exits 128.
  const source = payload.localPath!;
  await rm(path.join(source, '.git'), { recursive: true });
  await mkdir(path.join(source, 'metadata'));
  await symlink('metadata', path.join(source, '.git'));
  expect(await usableCheckout(source)).toEqual({ unknown: 'git exited 128', repairNeeded: true });
  for (let refresh = 1; refresh <= 3; refresh++) {
    await expect(runRefresh(payload)).rejects.toThrow(
      /^Not refreshed: the folder this repository was imported from \(.*\) could not be examined \(git exited 128\)\. Nothing was moved\. Retry cannot help until that folder is repaired\.$/,
    );
    expect(row.status).toBe('error');
    await untouched(dest);
  }
});

it('a usable source folder is still copied over an unusable checkout', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  await runRefresh(payload);
  const asides = (await readdir(path.dirname(dest))).filter((entry) =>
    entry.startsWith('r1.aside-'),
  );
  expect(asides).toHaveLength(1);
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(
    await git(payload.localPath!, ['rev-parse', 'HEAD']),
  );
  expect(row.status).toBe('ready');
});

const asidesOf = async (dest: string) =>
  (await readdir(path.dirname(dest)))
    .filter((entry) => entry.startsWith('r1.aside-'))
    .map((entry) => path.join(path.dirname(dest), entry));

/** Stands the copy or clone that follows the move in for one that leaves half a tree behind and throws. */
function failBuilding(kind: 'copy' | 'clone', cause: Error) {
  const leaveHalf = async (to: string) => {
    await mkdir(to, { recursive: true });
    await writeFile(path.join(to, 'half.txt'), 'x\n');
    throw cause;
  };
  if (kind === 'copy') h.copyFault = (_src, to) => leaveHalf(to);
  else h.clone.mockImplementationOnce((_url: string, to: string) => leaveHalf(to));
}
/** A tree the copy or clone finished that is not a checkout: the copy leaves a file, the clone nothing. */
function buildNoCheckout(kind: 'copy' | 'clone') {
  if (kind === 'copy')
    h.copyFault = async (_src, to) => {
      await writeFile(path.join(to, 'notes.md'), 'no .git\n');
    };
}
/** The payload each kind of rebuild comes from; the fixture's folder is a usable source for `copy`. */
const rebuildFrom = { copy: (payload: RepoJobPayload) => payload, clone: () => remotePayload };

it.each(['copy', 'clone'] as const)(
  'a %s that throws after the move ends the job unrecoverably, naming the aside and keeping the cause',
  async (kind) => {
    const { dest, payload } = await fixture();
    await rm(path.join(dest, '.git/HEAD'));
    const cause = new Error(`${kind} failed: simulated`);
    failBuilding(kind, cause);
    const err = await runRefresh(rebuildFrom[kind](payload)).catch((e: unknown) => e);
    const [aside, ...more] = await asidesOf(dest);
    expect(more).toEqual([]);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain(aside);
    expect((err as Error).message).toContain(cause.message);
    expect((err as Error).cause).toBe(cause);
    expect(row.status).toBe('error');
    expect(row.statusMessage).toBe((err as Error).message);
    expect(h.persist).not.toHaveBeenCalled();
    expect(await readFile(path.join(aside!, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
  },
);

it.each(['copy', 'clone'] as const)(
  'a %s that builds a tree that is not usable ends the job unrecoverably, naming the aside',
  async (kind) => {
    const { dest, payload } = await fixture();
    await rm(path.join(dest, '.git/HEAD'));
    buildNoCheckout(kind);
    const err = await runRefresh(rebuildFrom[kind](payload)).catch((e: unknown) => e);
    const [aside, ...more] = await asidesOf(dest);
    expect(more).toEqual([]);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain(aside);
    expect((err as Error).message).toMatch(/the rebuilt checkout is not usable\.$/);
    expect(row.status).toBe('error');
    expect(row.statusMessage).toBe((err as Error).message);
    expect(h.persist).not.toHaveBeenCalled();
    expect(await readFile(path.join(aside!, '.haive-data/plan.md'), 'utf8')).toBe('pending\n');
  },
);

it('a rebuilt tree git gave no answer about ends the job unrecoverably too, and says why', async () => {
  const { dest } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  // The first --show-cdup read is the checkout's own; the second is the rebuilt tree's.
  shim = await killGit(['rev-parse', '--show-cdup'], { after: 1 });
  h.clone.mockImplementationOnce((_url: string, to: string) => mkdir(to, { recursive: true }));
  const err = await runRefresh(remotePayload).catch((e: unknown) => e);
  const [aside] = await asidesOf(dest);
  expect(err).toBeInstanceOf(UnrecoverableError);
  expect((err as Error).message).toContain(aside);
  expect((err as Error).message).toMatch(
    /the rebuilt checkout could not be examined \(.*SIGKILL.*\)\.$/,
  );
  expect(row.status).toBe('error');
  expect(h.persist).not.toHaveBeenCalled();
});

it.each(['throws', 'builds no checkout'] as const)(
  'a clone that %s after nothing was set aside ends the job unrecoverably and names no folder',
  async (how) => {
    const { dest } = await fixture();
    await rm(dest, { recursive: true });
    const cause = new Error('clone failed: simulated');
    if (how === 'throws') failBuilding('clone', cause);
    const err = await runRefresh(remotePayload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).cause).toBe(how === 'throws' ? cause : undefined);
    expect((err as Error).message).not.toContain('previous folder');
    expect(await asidesOf(dest)).toEqual([]);
    expect(row.status).toBe('error');
  },
);

it('a refusal before the move stays an ordinary error, which nothing makes final', async () => {
  const { dest, payload } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  await rm(payload.localPath!, { recursive: true });
  const err = await runRefresh(payload).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UnrecoverableError);
  await untouched(dest);
});

it('the credential built before the move reaches the clone that follows it', async () => {
  const { dest } = await fixture();
  await rm(path.join(dest, '.git/HEAD'));
  const auth = { argv: ['-c', 'credential.helper=x'], env: { GIT_HAIVE_USER: 'u' }, secret: 's' };
  h.helper.mockResolvedValueOnce(auth);
  h.clone.mockImplementationOnce(async () => {
    const siblings = await readdir(path.dirname(dest));
    expect(siblings.filter((entry) => entry.startsWith('r1.aside-'))).toHaveLength(1);
    expect(siblings).not.toContain('r1');
    // What a real clone leaves, since the rebuild reads what it built.
    await git(root, ['clone', path.join(root, 'source'), dest]);
  });
  await handleRefresh(remotePayload, db, root);
  expect(h.helper).toHaveBeenCalledWith(db, 'cred-1', 'u1', 'https://git.example.test/r1.git');
  expect(h.clone).toHaveBeenCalledWith('https://git.example.test/r1.git', dest, 'main', auth);
  expect(row.status).toBe('ready');
});

it('an unreadable first gate after a retry puts pending bytes and index back', async () => {
  const { dest, payload } = await fixture();
  const file = '.haive-data/plan.md';
  await git(dest, ['add', '--', file]);
  const staged = await git(dest, ['ls-files', '-s', '--', file]);
  const before = await git(dest, ['rev-parse', 'HEAD']);
  const aside = vi.spyOn(projections, 'setAsideHaiveProjections');
  const restore = vi
    .spyOn(projections, 'restoreProjectionsInTx')
    .mockImplementationOnce(async () => {
      await expect(readFile(path.join(dest, file))).rejects.toHaveProperty('code', 'ENOENT');
      expect(await git(dest, ['ls-files', '-s', '--', file])).toBe('');
      await writeFile(path.join(dest, '.haive-data/plan.json'), '{}\n');
      shim = await failGit(['rev-parse', '--git-path']);
      return { outcome: 'retry' };
    });
  await handleRefresh(payload, db, root);
  expect(restore).toHaveBeenCalledOnce();
  expect(aside).toHaveBeenCalledTimes(2);
  await expect(aside.mock.results[1]!.value).rejects.toHaveProperty(
    'name',
    'GitOperationUnreadableError',
  );
  expect(row.statusMessage).toMatch(/could not be checked.*The checkout was not moved/);
  expect(await readFile(path.join(dest, file), 'utf8')).toBe('pending\n');
  expect(await git(dest, ['ls-files', '-s', '--', file])).toBe(staged);
  expect(await git(dest, ['rev-parse', 'HEAD'])).toBe(before);
});
