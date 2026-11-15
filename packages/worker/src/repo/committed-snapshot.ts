import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  parseCommittedSnapshotRefs,
  type CommittedSnapshotRef,
  taskScratchSubpath,
} from '@haive/shared';
import { logger as log, serializeError } from '@haive/shared/logger';
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
  maxInventoryBytes: 16 * 1024 * 1024,
  maxEntries: 50_000,
  maxDepth: 64,
  timeoutMs: 30_000,
};
export class CommittedSnapshotError extends Error {
  constructor(cause?: unknown, message?: string) {
    super(
      message ??
        'SNAPSHOT_INVALID: Committed snapshot is unavailable or invalid. Restore its recorded objects and inventory, or use Retry to start a new analysis generation.',
      { cause },
    );
    this.name = 'CommittedSnapshotError';
  }
}
export const isCommittedSnapshotFailure = (message: string | null | undefined) =>
  message?.startsWith('SNAPSHOT_INVALID:') === true ||
  message?.startsWith('dispatch failed before the agent was queued: SNAPSHOT_INVALID:') === true;
export class SnapshotReservationPredatesError extends CommittedSnapshotError {
  constructor() {
    super(
      undefined,
      'SNAPSHOT_INVALID: This reservation predates committed snapshots. Use Retry to start a new analysis generation.',
    );
    this.name = 'SnapshotReservationPredatesError';
  }
}

function transientDatabaseFault(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (
    let e = error;
    e && typeof e === 'object' && !seen.has(e);
    e = (e as { cause?: unknown }).cause
  ) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      (code.startsWith('CONNECTION_') ||
        code.startsWith('08') ||
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03'].includes(
          code,
        ))
    )
      return true;
  }
  return false;
}
function snapshotFailure(error: unknown, taskId: string, refs: object): Error {
  if (transientDatabaseFault(error)) throw error;
  if (error instanceof CommittedSnapshotError && error.cause !== undefined) return error;
  const ids: Record<string, string> = {};
  for (const key of ['snapshotRef', 'baseSnapshotRef'] as const) {
    const ref = (refs as Record<string, unknown>)[key];
    if (ref && typeof ref === 'object') {
      for (const field of ['inventoryId', 'commitOid', 'treeOid'] as const) {
        const value = (ref as Record<string, unknown>)[field];
        if (
          typeof value === 'string' &&
          /^(?:[0-9a-f-]{36}|[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
        )
          ids[`${key}_${field}`] = value;
      }
    }
  }
  const commitOid = (refs as { commitOid?: unknown }).commitOid;
  if (typeof commitOid === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid))
    ids.commitOid = commitOid;
  log.warn({ err: serializeError(error), taskId, ...ids }, 'Committed snapshot resolution failed');
  return new CommittedSnapshotError(error);
}
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
/** Scoped to ONE fan-out; never pass this cache to execution, which rechecks mounted bytes. */
export type SnapshotDispatchCache = Map<
  string,
  { identity: string; snapshot: ResolvedCommittedSnapshot }
>;
export function snapshotToolProfile<T extends 'full' | 'rag_only' | 'none' | undefined>(
  snapshot: boolean,
  requested: T,
): T | 'rag_only' {
  return snapshot && requested !== 'none' ? 'rag_only' : requested;
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
  const maxInventoryBytes = Math.min(limits.maxInventoryBytes, limits.maxEntries * 512);
  const deadline = Date.now() + limits.timeoutMs;
  const check = () => {
    if (Date.now() >= deadline) throw new CommittedSnapshotError();
  };
  check();
  return { limits, maxInventoryBytes, check, signal: AbortSignal.timeout(limits.timeoutMs) };
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
    for (const rel of ['objects/info/alternates', 'objects/info/http-alternates']) {
      if (await lstatNoFollow(anchor, rel, { strict: true })) throw new CommittedSnapshotError();
    }
    let value!: T;
    await runTool(
      'sh',
      [
        '-c',
        'cd /proc/self/fd/3 && GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null exec git "$@"',
        'snapshot-git',
        ...hardenGitArgs(['--git-dir=.', '-c', 'safe.directory=*', 'cat-file', '--batch-command']),
      ],
      {
        fds: [dir],
        signal: b.signal,
        interact: async (input, output) => {
          const chunks = output[Symbol.asyncIterator]();
          let pending = Buffer.alloc(0);
          async function read(size: number): Promise<Buffer> {
            const parts: Buffer[] = [];
            let remaining = size;
            while (remaining > 0) {
              if (pending.length === 0) {
                const next = await chunks.next();
                if (next.done) throw new Error('Git object stream ended early');
                pending = Buffer.from(next.value);
              }
              const take = Math.min(remaining, pending.length);
              parts.push(pending.subarray(0, take));
              pending = pending.subarray(take);
              remaining -= take;
            }
            return Buffer.concat(parts, size);
          }
          value = await use(async (kind, oid, cap) => {
            b.check();
            if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new CommittedSnapshotError();
            input.write(`${kind === '-s' ? 'info' : 'contents'} ${oid}\n`);
            let header = '';
            for (let i = 0; i < 256; i++) {
              const byte = (await read(1))[0]!;
              if (byte === 10) break;
              header += String.fromCharCode(byte);
            }
            const match = /^([0-9a-f]+) (commit|tree|blob) ([0-9]+)$/.exec(header);
            const size = Number(match?.[3]);
            if (!match || match[1] !== oid || !Number.isSafeInteger(size) || size < 0)
              throw new CommittedSnapshotError();
            if (kind === '-s') {
              if (match[2] !== 'blob') throw new CommittedSnapshotError();
              return Buffer.from(String(size));
            }
            if (match[2] !== kind || size > cap) throw new CommittedSnapshotError();
            const data = await read(size);
            if ((await read(1))[0] !== 10 || objectHash(kind, data, oid.length) !== oid)
              throw new CommittedSnapshotError();
            b.check();
            return data;
          });
        },
      },
    );
    return value;
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
  if (Buffer.byteLength(body) > b.maxInventoryBytes) throw new CommittedSnapshotError();
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
  const tracked = new Map(entries.map((e) => [e.path, e]));
  let bytes = 0,
    count = 0;
  const seen = new Set<string>();
  const directories = new Set(
    entries.flatMap((e) => {
      const parts = e.path.split('/');
      return parts.slice(0, -1).map((_part, i) => parts.slice(0, i + 1).join('/') + '/');
    }),
  );
  async function verify(dir: string, depth: number) {
    b.check();
    if (depth > b.limits.maxDepth) throw new CommittedSnapshotError();
    const directory = await lstatNoFollow(anchor, dir, { strict: true });
    if (
      directory?.kind !== 'directory' ||
      directory.stats.uid !== process.getuid?.() ||
      ((directory.stats.mode & 0o777) !== 0o755 &&
        !(dir === tree && (directory.stats.mode & 0o777) === 0o700))
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
        const prefix = rel.slice(tree.length + 1) + '/';
        if (!directories.has(prefix)) throw new CommittedSnapshotError();
        await verify(rel, depth + 1);
        continue;
      }
      if (info?.kind !== 'file' || info.stats.uid !== process.getuid?.())
        throw new CommittedSnapshotError();
      bytes += info.stats.size;
      if (bytes > b.limits.maxBytes) throw new CommittedSnapshotError();
      const name = rel.slice(tree.length + 1),
        expected = tracked.get(name);
      if (!expected || (info.stats.mode & 0o7777) !== (expected.mode === '100755' ? 0o555 : 0o444))
        throw new CommittedSnapshotError();
      const read = await readFileNoFollow(anchor, rel, { strict: true, maxBytes: expected.size });
      if (
        !read ||
        read.truncated ||
        read.data.length !== expected.size ||
        objectHash('blob', read.data, expected.oid.length) !== expected.oid
      )
        throw new CommittedSnapshotError();
      seen.add(name);
    }
  }
  const present = await lstatNoFollow(anchor, tree, { strict: true });
  if (present) {
    await verify(tree, 0); // Refuse altered bytes, extra files, links and unsafe permissions.
    b.check();
    if (seen.size === entries.length && (present.stats.mode & 0o777) === 0o755) return;
  }
  // A missing tree or a valid subset left by a crashed publication is rebuilt privately.
  const stage = `${artifact}/stage-${randomUUID()}`;
  const retired = `${artifact}/incomplete-${randomUUID()}`;
  await ensureDirNoFollow(anchor, stage, { mode: 0o755 });
  try {
    for (const entry of entries) {
      b.check();
      const bytes = await git('blob', entry.oid, entry.size);
      if (bytes.length !== entry.size) throw new CommittedSnapshotError();
      const parent = path.posix.dirname(entry.path);
      if (parent !== '.') await ensureDirNoFollow(anchor, `${stage}/${parent}`, { mode: 0o755 });
      await writeFileNoFollow(anchor, `${stage}/${entry.path}`, bytes, {
        mode: 'create-exclusive',
        fileMode: entry.mode === '100755' ? 0o555 : 0o444,
      });
    }
    b.check();
    if (present) await renameNoFollow(anchor, tree, retired, { noReplace: true });
    await renameNoFollow(anchor, stage, tree, { noReplace: true });
  } finally {
    await removeNoFollow(anchor, stage, { recursive: true });
    await removeNoFollow(anchor, retired, { recursive: true });
  }
  seen.clear();
  bytes = 0;
  count = 0;
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
    return await owned(opts, (anchor, namespace) => {
      const b = budget(opts);
      return withObjects(
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
      );
    });
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error;
    throw snapshotFailure(error, opts.scope.taskId, { commitOid });
  }
}

export async function resolveCommittedSnapshots(
  refs: { snapshotRef?: unknown; baseSnapshotRef?: unknown },
  opts: SnapshotOptions,
  consume?: (snapshots: ResolvedCommittedSnapshots) => Promise<void>,
  cache?: SnapshotDispatchCache,
): Promise<ResolvedCommittedSnapshots | null> {
  try {
    const parsed = parseCommittedSnapshotRefs(refs);
    if (!parsed.snapshotRef) return null;
    return await owned(opts, (anchor, namespace) => {
      const b = budget(opts);
      return withObjects(
        opts,
        async (git) => {
          async function resolve(ref: CommittedSnapshotRef): Promise<ResolvedCommittedSnapshot> {
            b.check();
            for (const key of ['taskId', 'userId', 'repositoryId'] as const)
              if (ref[key] !== opts.scope[key]) throw new CommittedSnapshotError();
            const identity = JSON.stringify([
              opts.scope,
              opts.repositoryRoot,
              opts.storageRoot ?? storageRoot(),
              ref,
            ]);
            const cached = cache?.get(ref.inventoryId);
            if (cached) {
              if (cached.identity !== identity) throw new CommittedSnapshotError();
              return cached.snapshot;
            }
            const artifact = `${namespace}/${ref.inventoryId}`;
            const stored = await readFileNoFollow(anchor, `${artifact}/inventory.json`, {
              strict: true,
              maxBytes: b.maxInventoryBytes,
            });
            if (!stored || stored.truncated || hash(stored.data) !== ref.inventorySha256)
              throw new CommittedSnapshotError();
            const data = await inventory(ref.commitOid, opts, git, b);
            if (data.treeOid !== ref.treeOid || data.body !== stored.data.toString('utf8'))
              throw new CommittedSnapshotError();
            await materialize(anchor, artifact, data.entries, git, b);
            const subpath = `${taskScratchSubpath(ref.userId, ref.taskId)}/committed-snapshots/${ref.inventoryId}/tree`;
            const snapshot = {
              subpath,
              workerRoot: path.join(opts.storageRoot ?? storageRoot(), subpath),
              tracked: new Set(data.entries.map((e) => e.path)),
            };
            cache?.set(ref.inventoryId, { identity, snapshot });
            return snapshot;
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
      );
    });
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error;
    throw snapshotFailure(error, opts.scope.taskId, refs);
  }
}

/** DB ownership is authoritative; neither the reference nor a module may choose a filesystem root. */
export async function resolveTaskCommittedSnapshots(
  db: Database,
  taskId: string,
  refs: { snapshotRef?: unknown; baseSnapshotRef?: unknown },
  consume?: (snapshots: ResolvedCommittedSnapshots) => Promise<void>,
  cache?: SnapshotDispatchCache,
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
      cache,
    );
  } catch (error) {
    if (error instanceof SnapshotConsumerError) throw error.original;
    throw snapshotFailure(error, taskId, refs);
  }
}
