import { readFileNoFollow } from '@haive/shared/fs-safe';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { logger } from '@haive/shared/logger';
import { runTool } from '../src/repo/tool-spawn.js';
import type { Database } from '@haive/database';
import { withTaskScratchWorkspace } from '../src/repo/scratch-workspace.js';
import { computeSecretMasks } from '../src/queues/cli-exec/secret-mask.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  symlink,
  chmod,
  stat,
  cp,
  chown,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  issueCommittedSnapshot,
  resolveCommittedSnapshots,
  resolveTaskCommittedSnapshots,
  SNAPSHOT_LIMITS,
} from '../src/repo/committed-snapshot.js';

vi.mock('../src/repo/tool-spawn.js', async (original) => ({
  ...(await original<object>()),
  runTool: vi.fn((await original<typeof import('../src/repo/tool-spawn.js')>()).runTool),
}));

vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  readFileNoFollow: vi.fn(
    (await original<typeof import('@haive/shared/fs-safe')>()).readFileNoFollow,
  ),
}));

let root: string;
let repo: string;
let commitOid: string;
const scope = { userId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID() };
const secret = randomBytes(24).toString('hex');
const binary = Buffer.concat([Buffer.from([0, 255]), randomBytes(12)]);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const options = () => ({ storageRoot: root, repositoryRoot: repo, scope });
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'committed-snapshot-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'history'), 'first');
  git('add', '.');
  git('commit', '-qm', 'first');
  await writeFile(join(repo, '.env'), secret);
  await writeFile(join(repo, 'data.bin'), binary);
  await mkdir(join(repo, 'nested'));
  await writeFile(join(repo, 'nested', 'content'), 'pinned');
  await writeFile(join(repo, 'nested', 'café'), 'unicode path');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  commitOid = git('rev-parse', 'HEAD');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('owned committed snapshot', () => {
  it('pins bytes despite dirty bytes and a moving HEAD, and rebuilds only that tree', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    await writeFile(join(repo, '.env'), randomBytes(24).toString('hex'));
    git('add', '.');
    git('commit', '-qm', 'move');
    git('replace', commitOid, git('rev-parse', 'HEAD'));
    let resolved = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(await readFile(join(resolved!.target.workerRoot, '.env'), 'utf8')).toBe(secret);
    expect(resolved!.target.tracked.has('.env')).toBe(true);
    expect(await readFile(join(resolved!.target.workerRoot, 'data.bin'))).toEqual(binary);
    expect(await readFile(join(resolved!.target.workerRoot, 'nested/content'), 'utf8')).toBe(
      'pinned',
    );
    await rm(resolved!.target.workerRoot, { recursive: true });
    resolved = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(await readFile(join(resolved!.target.workerRoot, '.env'), 'utf8')).toBe(secret);
  });
  it('binds the descriptor to DB ownership and holds the scratch fence through dispatch reads', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const previous = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = root;
    const task = { userId: scope.userId, repositoryId: scope.repositoryId };
    const repository = { userId: scope.userId, storagePath: repo, localPath: null };
    const db = {
      query: {
        tasks: { findFirst: async () => task },
        repositories: { findFirst: async () => repository },
      },
    } as unknown as Database;
    let release!: () => void, entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holdRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const reader = resolveTaskCommittedSnapshots(
        db,
        scope.taskId,
        { snapshotRef: ref },
        async (view) => {
          expect(view.target.tracked.has('.env')).toBe(true);
          entered();
          await holdRead;
        },
      );
      await Promise.race([
        enteredRead,
        reader.then(() => {
          throw new Error('Dispatch reader did not run');
        }),
      ]);
      let reaperEntered = false;
      const reaper = withTaskScratchWorkspace(scope.userId, scope.taskId, async () => {
        reaperEntered = true;
      });
      await Promise.resolve();
      expect(reaperEntered).toBe(false);
      release();
      await reader;
      await reaper;
      expect(reaperEntered).toBe(true);
      repository.userId = randomUUID();
      await expect(
        resolveTaskCommittedSnapshots(db, scope.taskId, { snapshotRef: ref }),
      ).rejects.toThrow('SNAPSHOT_INVALID');
    } finally {
      release?.();
      if (previous === undefined) delete process.env.REPO_STORAGE_ROOT;
      else process.env.REPO_STORAGE_ROOT = previous;
    }
  });
  it('keeps target and base distinct and refuses foreign scope, forged or missing inventory', async () => {
    const target = await issueCommittedSnapshot(commitOid, options());
    const base = await issueCommittedSnapshot(commitOid, options());
    const pair = await resolveCommittedSnapshots(
      { snapshotRef: target, baseSnapshotRef: base },
      options(),
    );
    expect(pair!.target.workerRoot).not.toBe(pair!.base!.workerRoot);
    await expect(
      resolveCommittedSnapshots({ snapshotRef: { ...target, taskId: randomUUID() } }, options()),
    ).rejects.toThrow('SNAPSHOT_INVALID');
    await expect(
      resolveCommittedSnapshots(
        { snapshotRef: { ...target, inventorySha256: 'f'.repeat(64) } },
        options(),
      ),
    ).rejects.toThrow('SNAPSHOT_INVALID');
    await expect(
      resolveCommittedSnapshots(
        { snapshotRef: { ...target, inventoryId: randomUUID() } },
        options(),
      ),
    ).rejects.toThrow('SNAPSHOT_INVALID');
  });
  it.each([
    ['maxBytes', 1],
    ['maxEntries', 1],
    ['maxDepth', 0],
    ['timeoutMs', 0],
  ] as const)('fails the injected %s bound', async (key, value) => {
    await expect(
      issueCommittedSnapshot(commitOid, { ...options(), limits: { [key]: value } }),
    ).rejects.toThrow('SNAPSHOT_INVALID');
  });
  it('refuses to issue an inventory above the resolver byte cap before publishing it', async () => {
    expect(SNAPSHOT_LIMITS.maxInventoryBytes).toBe(16 * 1024 * 1024);
    const ref = await issueCommittedSnapshot(commitOid, options());
    const namespace = join(root, scope.userId, '_scratch', scope.taskId, 'committed-snapshots');
    const body = await readFile(join(namespace, ref.inventoryId, 'inventory.json'), 'utf8');
    const size = Buffer.byteLength(body);
    expect(size).toBeGreaterThan(body.length);
    const exact = { ...options(), limits: { maxInventoryBytes: size } };
    const accepted = await issueCommittedSnapshot(commitOid, exact);
    expect(await resolveCommittedSnapshots({ snapshotRef: accepted }, exact)).not.toBeNull();
    const before = await readdir(namespace);
    await expect(
      issueCommittedSnapshot(commitOid, { ...options(), limits: { maxInventoryBytes: size - 1 } }),
    ).rejects.toThrow('SNAPSHOT_INVALID');
    expect(await readdir(namespace)).toEqual(before);
    await expect(
      resolveCommittedSnapshots(
        { snapshotRef: accepted },
        { ...options(), limits: { maxInventoryBytes: size - 1 } },
      ),
    ).rejects.toThrow('SNAPSHOT_INVALID');
  });
  it("refuses extra files while retaining the masking helper's tracked-secret policy", async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const result = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!;
    await writeFile(join(result.target.workerRoot, 'private.key'), randomBytes(24));
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
    const verified = result;
    expect(
      await computeSecretMasks(
        verified.target.workerRoot,
        {},
        '/haive/workdir',
        verified.target.tracked,
      ),
    ).toEqual([{ containerPath: '/haive/workdir/private.key', content: '' }]);
    expect(
      await computeSecretMasks(
        verified.target.workerRoot,
        { allow: ['private.key'] },
        '/haive/workdir',
        verified.target.tracked,
      ),
    ).toEqual([]);
    expect(
      await computeSecretMasks(
        verified.target.workerRoot,
        { denyExtend: ['nested/content'] },
        '/haive/workdir',
        verified.target.tracked,
      ),
    ).toEqual([{ containerPath: '/haive/workdir/private.key', content: '' }]);
    await expect(
      resolveCommittedSnapshots({ snapshotRef: { ...ref, treeOid: 'e'.repeat(40) } }, options()),
    ).rejects.toThrow('SNAPSHOT_INVALID');
  });
  it('refuses missing inventory, modified tracked bytes and an intermediate symlink', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const result = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!;
    const manifest = join(dirname(result.target.workerRoot), 'inventory.json');
    await rm(manifest);
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
    const next = await issueCommittedSnapshot(commitOid, options());
    const tree = (await resolveCommittedSnapshots({ snapshotRef: next }, options()))!.target
      .workerRoot;
    await chmod(join(tree, '.env'), 0o644);
    await writeFile(join(tree, '.env'), randomBytes(24));
    await expect(resolveCommittedSnapshots({ snapshotRef: next }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
    const last = await issueCommittedSnapshot(commitOid, options());
    const lastTree = (await resolveCommittedSnapshots({ snapshotRef: last }, options()))!.target
      .workerRoot;
    await rm(join(lastTree, 'nested'), { recursive: true });
    await symlink(join(repo, 'nested'), join(lastTree, 'nested'));
    await expect(resolveCommittedSnapshots({ snapshotRef: last }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
  });
  it('refuses traversal and a substituted tree symlink', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    await expect(
      resolveCommittedSnapshots({ snapshotRef: { ...ref, inventoryId: '../escape' } }, options()),
    ).rejects.toThrow('SNAPSHOT_INVALID');
    const resolved = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    await rm(resolved!.target.workerRoot, { recursive: true });
    await symlink(repo, resolved!.target.workerRoot);
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
  });
  it('resolves HEAD from a depth-one clone with multiple source commits', async () => {
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow]);
    const opts = { ...options(), repositoryRoot: shallow };
    const head = execFileSync('git', ['-C', shallow, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(
      execFileSync('git', ['-C', shallow, 'rev-parse', '--is-shallow-repository'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
    const ref = await issueCommittedSnapshot(head, opts);
    expect(
      (await resolveCommittedSnapshots({ snapshotRef: ref }, opts))?.target.tracked.has('.env'),
    ).toBe(true);
  });
  it.each(['empty', 'incomplete'])('rebuilds a crash-claimed %s tree', async (kind) => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const tree = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!.target
      .workerRoot;
    await rm(tree, { recursive: true });
    await mkdir(tree, { mode: 0o700 });
    if (kind === 'incomplete') await writeFile(join(tree, '.env'), secret, { mode: 0o444 });
    const rebuilt = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(await readFile(join(rebuilt!.target.workerRoot, 'nested/content'), 'utf8')).toBe(
      'pinned',
    );
  });
  it.each([0o002, 0o077])(
    'sets readable, non-writable directory modes under umask %s',
    async (mask) => {
      const previous = process.umask(mask);
      try {
        const ref = await issueCommittedSnapshot(commitOid, options());
        const view = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
        expect((await stat(join(view!.target.workerRoot, 'nested'))).mode & 0o777).toBe(0o755);
      } finally {
        process.umask(previous);
      }
    },
  );
  it('does not charge concurrent resolver lock wait against the work budget', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const blocker = withTaskScratchWorkspace(scope.userId, scope.taskId, async () => {
      enter();
      await held;
    });
    await entered;
    try {
      const resolutions = Array.from({ length: 4 }, () =>
        resolveCommittedSnapshots(
          { snapshotRef: ref },
          { ...options(), limits: { timeoutMs: 10000 } },
        ),
      );
      now += 50000;
      release();
      await blocker;
      const views = await Promise.all(resolutions);
      expect(views.every((v) => v!.target.tracked.has('.env'))).toBe(true);
    } finally {
      release();
      clock.mockRestore();
    }
  });
  it.each([
    ['maxBytes', 1],
    ['maxEntries', 1],
    ['maxDepth', 0],
    ['timeoutMs', 0],
  ] as const)('fails the resolve-time %s bound', async (key, value) => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    await expect(
      resolveCommittedSnapshots({ snapshotRef: ref }, { ...options(), limits: { [key]: value } }),
    ).rejects.toThrow('SNAPSHOT_INVALID');
  });
  it.each(['symlink', 'gitlink', '.git', 'alternates', 'http-alternates'])(
    'refuses a committed or object-store %s',
    async (kind) => {
      const copy = join(root, `unsafe-${kind}`);
      await cp(repo, copy, { recursive: true });
      const localGit = (...args: string[]) =>
        execFileSync('git', ['-C', copy, ...args], { encoding: 'utf8' }).trim();
      let oid = commitOid;
      if (kind === 'alternates' || kind === 'http-alternates') {
        await writeFile(join(copy, '.git/objects/info', kind), repo + '/.git/objects');
      } else {
        const blob = localGit('rev-parse', `${commitOid}:.env`);
        const mode = kind === 'symlink' ? '120000' : kind === 'gitlink' ? '160000' : '100644';
        const childOid = kind === 'gitlink' ? commitOid : blob;
        // Raw trees allow adversarial metadata names which git's index refuses to write.
        const raw = Buffer.concat([
          Buffer.from(`${mode} ${kind === '.git' ? '.git' : 'unsafe'}\0`),
          Buffer.from(childOid, 'hex'),
        ]);
        const treeOid = execFileSync(
          'git',
          ['-C', copy, 'hash-object', '-t', 'tree', '--literally', '-w', '--stdin'],
          { input: raw, encoding: 'utf8' },
        ).trim();
        oid = execFileSync(
          'git',
          ['-C', copy, 'hash-object', '-t', 'commit', '--literally', '-w', '--stdin'],
          {
            input: `tree ${treeOid}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfixture\n`,
            encoding: 'utf8',
          },
        ).trim();
      }
      await expect(
        issueCommittedSnapshot(oid, { ...options(), repositoryRoot: copy }),
      ).rejects.toThrow('SNAPSHOT_INVALID');
    },
  );
  it('refuses an unsafe directory mode and an unsafe tracked-file mode', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const tree = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!.target
      .workerRoot;
    await chmod(join(tree, 'nested'), 0o775);
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
    await chmod(join(tree, 'nested'), 0o755);
    await chmod(join(tree, '.env'), 0o444 | 0o111);
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
  });
  it.runIf(process.getuid?.() === 0)('refuses a foreign tree uid', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const tree = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!.target
      .workerRoot;
    await chown(join(tree, '.env'), 65534, 65534);
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
  });
  it('preserves the original cause on a sanitized snapshot error', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const db = {
      query: {
        tasks: {
          findFirst: async () => {
            throw new Error('lookup failed');
          },
        },
      },
    } as unknown as Database;
    const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = await resolveTaskCommittedSnapshots(db, scope.taskId, { snapshotRef: ref }).catch(
      (e) => e,
    );
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        taskId: scope.taskId,
        snapshotRef_inventoryId: ref.inventoryId,
      }),
      expect.any(String),
    );
    logged.mockRestore();
    expect(error.message).toContain('SNAPSHOT_INVALID');
    expect(error.cause?.message).toBe('lookup failed');
  });
  it.each(['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'ECONNRESET', '57P01'])(
    'preserves transient %s faults for retry',
    async (code) => {
      const ref = await issueCommittedSnapshot(commitOid, options());
      const driver = Object.assign(new Error('database interrupted'), { code });
      const failure = new DrizzleQueryError('select task', [], driver);
      const db = {
        query: {
          tasks: {
            findFirst: async () => {
              throw failure;
            },
          },
        },
      } as unknown as Database;
      await expect(
        resolveTaskCommittedSnapshots(db, scope.taskId, { snapshotRef: ref }),
      ).rejects.toBe(failure);
    },
  );

  it('uses one bounded Git batch child for issue and for resolve', async () => {
    vi.mocked(runTool).mockClear();
    const ref = await issueCommittedSnapshot(commitOid, options());
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTool).mock.calls[0]![1]).toContain('--batch-command');
    vi.mocked(runTool).mockClear();
    await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('reuses a verified inventory within one fan-out while exec still verifies tree bytes', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const cache = new Map();
    const first = await resolveCommittedSnapshots(
      { snapshotRef: ref },
      options(),
      undefined,
      cache,
    );
    vi.mocked(readFileNoFollow).mockClear();
    const next = await resolveCommittedSnapshots(
      { snapshotRef: ref, baseSnapshotRef: ref },
      options(),
      undefined,
      cache,
    );
    expect(next!.target).toBe(first!.target);
    expect(next!.base).toBe(first!.target);
    expect(readFileNoFollow).not.toHaveBeenCalled();
    await expect(
      resolveCommittedSnapshots(
        { snapshotRef: { ...ref, treeOid: 'f'.repeat(40) } },
        options(),
        undefined,
        cache,
      ),
    ).rejects.toThrow('SNAPSHOT_INVALID');
    await chmod(join(first!.target.workerRoot, '.env'), 0o644);
    await writeFile(join(first!.target.workerRoot, '.env'), randomBytes(24));
    await expect(resolveCommittedSnapshots({ snapshotRef: ref }, options())).rejects.toThrow(
      'SNAPSHOT_INVALID',
    );
  });
});
