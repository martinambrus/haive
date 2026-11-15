import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  parseCommittedSnapshotRefs,
  type CommittedSnapshotRef,
  taskScratchSubpath,
} from '@haive/shared';
import { hardenGitArgs } from '@haive/shared/git-args';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  openDirNoFollow,
  readFileNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { runTool } from './tool-spawn.js';
import { withTaskScratchWorkspace } from './scratch-workspace.js';

export const SNAPSHOT_BASE_TARGET = '/haive/diff-base';
export const SNAPSHOT_LIMITS = {
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 50_000,
  maxDepth: 64,
  timeoutMs: 30_000,
};
export class CommittedSnapshotError extends Error {
  constructor() {
    super(
      'SNAPSHOT_INVALID: Committed snapshot is unavailable or invalid. Restore its recorded objects and inventory, or use Retry to start a new analysis generation.',
    );
    this.name = 'CommittedSnapshotError';
  }
}
export const isCommittedSnapshotFailure = (message: string | null | undefined) =>
  message?.startsWith('SNAPSHOT_INVALID:') === true;
type Scope = Pick<CommittedSnapshotRef, 'userId' | 'repositoryId' | 'taskId'>;
export interface SnapshotOptions {
  scope: Scope;
  repositoryRoot: string;
  storageRoot?: string;
  limits?: Partial<typeof SNAPSHOT_LIMITS>;
}
type Entry = { path: string; oid: string; mode: '100644' | '100755'; size: number };
export interface ResolvedCommittedSnapshot {
  workerRoot: string;
  subpath: string;
  tracked: ReadonlySet<string>;
}
export interface ResolvedCommittedSnapshots {
  target: ResolvedCommittedSnapshot;
  base: ResolvedCommittedSnapshot | null;
}
const storageRoot = () => process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const objectHash = (kind: string, data: Buffer, width: number) =>
  createHash(width === 40 ? 'sha1' : 'sha256')
    .update(`${kind} ${data.length}\0`)
    .update(data)
    .digest('hex');
const validPath = (name: string) =>
  name.length > 0 &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  name.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');

function budget(opts: SnapshotOptions) {
  const limits = { ...SNAPSHOT_LIMITS, ...opts.limits };
  const deadline = Date.now() + limits.timeoutMs;
  const check = () => {
    if (Date.now() >= deadline) throw new CommittedSnapshotError();
  };
  check();
  return { limits, check, signal: AbortSignal.timeout(limits.timeoutMs) };
}

/** No checkout, archive filters, hooks, transport or ambient credentials. Git receives only a held
 * .git descriptor. Every object is independently hashed, including trees and the commit itself. */
async function withObjects<T>(
  opts: SnapshotOptions,
  use: (git: (kind: string, oid: string, cap: number) => Promise<Buffer>) => Promise<T>,
  b: ReturnType<typeof budget>,
): Promise<T> {
  const dir = await openDirNoFollow(opts.repositoryRoot, '.git');
  try {
    const anchor = `/proc/self/fd/${dir.fd}`;
    for (const rel of ['objects', 'objects/pack']) {
      const info = await lstatNoFollow(anchor, rel, { strict: true });
      if (info && info.kind !== 'directory') throw new CommittedSnapshotError();
    }
    for (const rel of ['objects/info/alternates', 'objects/info/http-alternates', 'shallow']) {
      if (await lstatNoFollow(anchor, rel, { strict: true })) throw new CommittedSnapshotError();
    }
    return await use(async (kind, oid, cap) => {
      b.check();
      const args = hardenGitArgs(['--git-dir=.', '-c', 'safe.directory=*', 'cat-file', kind, oid]);
      const result = await runTool(
        'sh',
        [
          '-c',
          'cd /proc/self/fd/3 && GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null exec git "$@"',
          'snapshot-git',
          ...args,
        ],
        { fds: [dir], maxStdout: cap, signal: b.signal },
      );
      b.check();
      if (kind !== '-s' && objectHash(kind, result.stdoutBytes, oid.length) !== oid)
        throw new CommittedSnapshotError();
      return result.stdoutBytes;
    });
  } finally {
    await dir.close();
  }
}

async function inventory(
  commitOid: string,
  opts: SnapshotOptions,
  git: (kind: string, oid: string, cap: number) => Promise<Buffer>,
  b: ReturnType<typeof budget>,
) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid)) throw new CommittedSnapshotError();
  const commit = await git('commit', commitOid, 1024 * 1024);
  const treeOid = /^tree ([0-9a-f]+)\n/.exec(commit.toString('utf8'))?.[1];
  if (!treeOid || treeOid.length !== commitOid.length) throw new CommittedSnapshotError();
  const entries: Entry[] = [];
  let count = 0,
    bytes = 0;
  async function tree(oid: string, prefix: string, depth: number): Promise<void> {
    b.check();
    if (depth > b.limits.maxDepth) throw new CommittedSnapshotError();
    const raw = await git('tree', oid, Math.min(16 * 1024 * 1024, b.limits.maxEntries * 512));
    let pos = 0;
    while (pos < raw.length) {
      if (++count > b.limits.maxEntries) throw new CommittedSnapshotError();
      const space = raw.indexOf(32, pos),
        nul = raw.indexOf(0, space + 1);
      if (space < pos || nul < space || nul + 1 + oid.length / 2 > raw.length)
        throw new CommittedSnapshotError();
      const mode = raw.subarray(pos, space).toString('ascii');
      const nameBytes = raw.subarray(space + 1, nul),
        name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes) || name.includes('/') || !validPath(name))
        throw new CommittedSnapshotError();
      const rel = prefix + name;
      const child = raw.subarray(nul + 1, nul + 1 + oid.length / 2).toString('hex');
      pos = nul + 1 + oid.length / 2;
      if (mode === '40000') {
        await tree(child, rel + '/', depth + 1);
        continue;
      }
      // Symlinks and gitlinks have no immutable regular-file view. Refuse rather than dereference.
      if (mode !== '100644' && mode !== '100755') throw new CommittedSnapshotError();
      const size = Number((await git('-s', child, 64)).toString('ascii').trim());
      bytes += size;
      if (!Number.isSafeInteger(size) || size < 0 || bytes > b.limits.maxBytes)
        throw new CommittedSnapshotError();
      entries.push({ path: rel, oid: child, mode, size });
    }
  }
  await tree(treeOid, '', 0);
  entries.sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0));
  if (new Set(entries.map((e) => e.path)).size !== entries.length)
    throw new CommittedSnapshotError();
  const body = JSON.stringify({
    version: 1,
    userId: opts.scope.userId,
    repositoryId: opts.scope.repositoryId,
    taskId: opts.scope.taskId,
    commitOid,
    treeOid,
    entries,
  });
  return { treeOid, entries, body };
}

/** All artifact IO is relative to the held storage owner, never a sandbox-chosen anchor. The
 * private namespace is host-owned; trees alone are mounted. The scratch reaper shares this fence. */
async function owned<T>(
  opts: SnapshotOptions,
  use: (anchor: string, namespace: string) => Promise<T>,
): Promise<T> {
  // Reuse the strict owner DTO even for issuance, before deriving any path.
  parseCommittedSnapshotRefs({
    snapshotRef: {
      version: 1,
      ...opts.scope,
      commitOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      inventoryId: randomUUID(),
      inventorySha256: '0'.repeat(64),
    },
  });
  return withTaskScratchWorkspace(opts.scope.userId, opts.scope.taskId, async () => {
    const root = opts.storageRoot ?? storageRoot();
    await ensureDirNoFollow(root, opts.scope.userId);
    const owner = await openDirNoFollow(root, opts.scope.userId);
    try {
      const anchor = `/proc/self/fd/${owner.fd}`;
      const namespace = `_scratch/${opts.scope.taskId}/committed-snapshots`;
      await ensureDirNoFollow(anchor, namespace, { mode: 0o700 });
      const info = await lstatNoFollow(anchor, namespace, { strict: true });
      if (
        info?.kind !== 'directory' ||
        info.stats.uid !== process.getuid?.() ||
        (info.stats.mode & 0o777) !== 0o700
      )
        throw new CommittedSnapshotError();
      return await use(anchor, namespace);
    } finally {
      await owner.close();
    }
  });
}

async function materialize(
  anchor: string,
  artifact: string,
  entries: Entry[],
  git: (kind: string, oid: string, cap: number) => Promise<Buffer>,
  b: ReturnType<typeof budget>,
) {
  const tree = `${artifact}/tree`;
  if (!(await lstatNoFollow(anchor, tree, { strict: true }))) {
    const stage = `${artifact}/stage-${randomUUID()}`;
    await ensureDirNoFollow(anchor, stage, { mode: 0o755 });
    try {
      for (const entry of entries) {
        b.check();
        const bytes = await git('blob', entry.oid, entry.size);
        if (bytes.length !== entry.size) throw new CommittedSnapshotError();
        await writeFileNoFollow(anchor, `${stage}/${entry.path}`, bytes, {
          mode: 'create-exclusive',
          createParents: true,
          fileMode: entry.mode === '100755' ? 0o555 : 0o444,
        });
      }
      b.check();
      await renameNoFollow(anchor, stage, tree, { noReplace: true });
    } finally {
      await removeNoFollow(anchor, stage, { recursive: true });
    }
  }
  const tracked = new Map(entries.map((e) => [e.path, e]));
  let bytes = 0,
    count = 0;
  const seen = new Set<string>();
  async function verify(dir: string, depth: number) {
    b.check();
    if (depth > b.limits.maxDepth) throw new CommittedSnapshotError();
    const directory = await lstatNoFollow(anchor, dir, { strict: true });
    if (
      directory?.kind !== 'directory' ||
      directory.stats.uid !== process.getuid?.() ||
      (directory.stats.mode & 0o022) !== 0
    )
      throw new CommittedSnapshotError();
    const listing = await readdirNoFollow(anchor, dir, { strict: true });
    if (!listing) throw new CommittedSnapshotError();
    for (const item of listing) {
      b.check();
      if (++count > b.limits.maxEntries || !validPath(item.name))
        throw new CommittedSnapshotError();
      const rel = `${dir}/${item.name}`;
      const info = await lstatNoFollow(anchor, rel, { strict: true });
      if (info?.kind === 'directory') {
        await verify(rel, depth + 1);
        continue;
      }
      if (info?.kind !== 'file' || info.stats.uid !== process.getuid?.())
        throw new CommittedSnapshotError();
      bytes += info.stats.size;
      if (bytes > b.limits.maxBytes) throw new CommittedSnapshotError();
      const name = rel.slice(tree.length + 1),
        expected = tracked.get(name);
      if (!expected) continue; // Additional files receive ordinary secret masking, never tracked status.
      const read = await readFileNoFollow(anchor, rel, { strict: true, maxBytes: expected.size });
      if (
        !read ||
        read.truncated ||
        read.data.length !== expected.size ||
        objectHash('blob', read.data, expected.oid.length) !== expected.oid ||
        (info.stats.mode & 0o111) !== (expected.mode === '100755' ? 0o111 : 0)
      )
        throw new CommittedSnapshotError();
      seen.add(name);
    }
  }
  await verify(tree, 0);
  b.check();
  if (seen.size !== entries.length) throw new CommittedSnapshotError();
}

class SnapshotConsumerError extends Error {
  constructor(readonly original: unknown) {
    super();
  }
}

export async function issueCommittedSnapshot(
  commitOid: string,
  opts: SnapshotOptions,
): Promise<CommittedSnapshotRef> {
  try {
    const b = budget(opts);
    return await owned(opts, (anchor, namespace) =>
      withObjects(
        opts,
        async (git) => {
          const data = await inventory(commitOid, opts, git, b);
          const ref: CommittedSnapshotRef = {
            version: 1,
            ...opts.scope,
            commitOid,
            treeOid: data.treeOid,
            inventoryId: randomUUID(),
            inventorySha256: hash(data.body),
          };
          const artifact = `${namespace}/${ref.inventoryId}`;
          await ensureDirNoFollow(anchor, artifact, { mode: 0o700 });
          await writeFileNoFollow(anchor, `${artifact}/inventory.json`, data.body, {
            mode: 'create-exclusive',
            fileMode: 0o400,
            durable: true,
          });
          await materialize(anchor, artifact, data.entries, git, b);
          return ref;
        },
        b,
      ),
    );
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error;
    throw new CommittedSnapshotError();
  }
}

export async function resolveCommittedSnapshots(
  refs: { snapshotRef?: unknown; baseSnapshotRef?: unknown },
  opts: SnapshotOptions,
  consume?: (snapshots: ResolvedCommittedSnapshots) => Promise<void>,
): Promise<ResolvedCommittedSnapshots | null> {
  try {
    const parsed = parseCommittedSnapshotRefs(refs);
    if (!parsed.snapshotRef) return null;
    const b = budget(opts);
    return await owned(opts, (anchor, namespace) =>
      withObjects(
        opts,
        async (git) => {
          async function resolve(ref: CommittedSnapshotRef): Promise<ResolvedCommittedSnapshot> {
            b.check();
            for (const key of ['taskId', 'userId', 'repositoryId'] as const)
              if (ref[key] !== opts.scope[key]) throw new CommittedSnapshotError();
            const artifact = `${namespace}/${ref.inventoryId}`;
            const stored = await readFileNoFollow(anchor, `${artifact}/inventory.json`, {
              strict: true,
              maxBytes: Math.min(16 * 1024 * 1024, b.limits.maxEntries * 512),
            });
            if (!stored || stored.truncated || hash(stored.data) !== ref.inventorySha256)
              throw new CommittedSnapshotError();
            const data = await inventory(ref.commitOid, opts, git, b);
            if (data.treeOid !== ref.treeOid || data.body !== stored.data.toString('utf8'))
              throw new CommittedSnapshotError();
            await materialize(anchor, artifact, data.entries, git, b);
            const subpath = `${taskScratchSubpath(ref.userId, ref.taskId)}/committed-snapshots/${ref.inventoryId}/tree`;
            return {
              subpath,
              workerRoot: path.join(opts.storageRoot ?? storageRoot(), subpath),
              tracked: new Set(data.entries.map((e) => e.path)),
            };
          }
          const snapshots = {
            target: await resolve(parsed.snapshotRef!),
            base: parsed.baseSnapshotRef ? await resolve(parsed.baseSnapshotRef) : null,
          };
          if (consume) {
            try {
              await consume(snapshots);
            } catch (cause) {
              throw new SnapshotConsumerError(cause);
            }
          }
          return snapshots;
        },
        b,
      ),
    );
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error;
    throw new CommittedSnapshotError();
  }
}

/** DB ownership is authoritative; neither the reference nor a module may choose a filesystem root. */
export async function resolveTaskCommittedSnapshots(
  db: Database,
  taskId: string,
  refs: { snapshotRef?: unknown; baseSnapshotRef?: unknown },
  consume?: (snapshots: ResolvedCommittedSnapshots) => Promise<void>,
): Promise<ResolvedCommittedSnapshots | null> {
  try {
    const parsed = parseCommittedSnapshotRefs(refs);
    if (!parsed.snapshotRef) return null;
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { userId: true, repositoryId: true },
    });
    if (!task?.repositoryId) throw new CommittedSnapshotError();
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { userId: true, storagePath: true, localPath: true },
    });
    if (!repo || repo.userId !== task.userId) throw new CommittedSnapshotError();
    const repositoryRoot =
      repo.storagePath ??
      repo.localPath ??
      path.join(storageRoot(), task.userId, task.repositoryId);
    return await resolveCommittedSnapshots(
      parsed,
      {
        repositoryRoot,
        scope: { taskId, userId: task.userId, repositoryId: task.repositoryId },
      },
      consume,
    );
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error.original;
    throw new CommittedSnapshotError();
  }
}
