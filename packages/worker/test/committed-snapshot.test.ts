import { computeSecretMasks } from '../src/queues/cli-exec/secret-mask.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  issueCommittedSnapshot,
  resolveCommittedSnapshots,
} from '../src/repo/committed-snapshot.js';

let root: string;
let repo: string;
let commitOid: string;
const scope = { userId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID() };
const secret = randomBytes(24).toString('hex');
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
  await writeFile(join(repo, '.env'), secret);
  await mkdir(join(repo, 'nested'));
  await writeFile(join(repo, 'nested', 'content'), 'pinned');
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
    let resolved = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(await readFile(join(resolved!.target.workerRoot, '.env'), 'utf8')).toBe(secret);
    expect(resolved!.target.tracked.has('.env')).toBe(true);
    expect(await readFile(join(resolved!.target.workerRoot, 'nested/content'), 'utf8')).toBe(
      'pinned',
    );
    await rm(resolved!.target.workerRoot, { recursive: true });
    resolved = await resolveCommittedSnapshots({ snapshotRef: ref }, options());
    expect(await readFile(join(resolved!.target.workerRoot, '.env'), 'utf8')).toBe(secret);
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
  it('keeps committed secrets visible and masks only denied additions using the host inventory', async () => {
    const ref = await issueCommittedSnapshot(commitOid, options());
    const result = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!;
    await writeFile(join(result.target.workerRoot, 'private.key'), randomBytes(24));
    const verified = (await resolveCommittedSnapshots({ snapshotRef: ref }, options()))!;
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
});
