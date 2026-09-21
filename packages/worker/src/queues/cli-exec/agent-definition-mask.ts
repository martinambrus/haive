/**
 * Read-only empty tmpfs mounts over every repo-level agent directory, for an isolated invocation.
 *
 * The persona an isolated dispatch needs is already IN its prompt (dispatcher.ts pastes the body),
 * so the directories the pointer used to name are context the agent no longer has a use for — and
 * every CLI lists them eagerly, which is what this removes. MEASURED before isolation existed: each
 * invocation's listing carried every repo agent's name and description, and the claude binary's own
 * 8,000-char skill budget left 1 of 18 repo skills described.
 *
 * Rides the same shape as {@link resolveDdevGeneratedMasks}: an outer resolver that does the DB
 * lookup inside one fail-open try/catch, and a pure core exposed for fixture-tree tests. Two
 * differences, both deliberate:
 *
 * - it returns MOUNTS, not `SandboxExtraFile`s. A file mask needs content; an empty directory is a
 *   `tmpfs`, which is the form `DockerVolumeMount.tmpfs` added for exactly this.
 * - it records what it masked, so {@link removeAgentMaskStubs} can clean up a stub Docker created.
 *
 * FAILS OPEN, unlike secret masking. This is a context control, not a confidentiality one: a stat
 * that throws masks nothing and logs, and the persona body was already pasted at dispatch, so the
 * run is only as noisy as it is today. `SecretMaskError`'s fail-closed rule would trade a real
 * outage for a hypothetical one.
 */
import { posix } from 'node:path';
import { lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { AGENT_DIRECTORIES } from '@haive/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { workspaceAnchor } from '../../repo/worktree-paths.js';
import { resolveInvocationWorkerRoot } from './resolvers.js';
import { log } from './_shared.js';

/** What was masked, so cleanup can tell a stub Docker created from a directory that was already
 *  there. `inode` is the identity BEFORE the run: a mount over an existing directory leaves that
 *  directory untouched underneath, while a mount over a missing path makes Docker materialise a
 *  root-owned stub that outlives the container. */
export interface AgentMaskRecord {
  /** Repository-relative directory, e.g. `.claude/agents`. */
  rel: string;
  /** Absolute worker-side path, for the cleanup's own stat. */
  workerPath: string;
  /** The anchor the path was resolved under, so cleanup never re-resolves by name. */
  anchor: string;
  /** Path relative to that anchor. */
  anchorRel: string;
  /** Inode of the directory as it was found, or null when it did not exist and Docker will create
   *  a stub. A null here is what makes a later empty directory removable. */
  inode: number | null;
}

export interface AgentDefinitionMasks {
  mounts: DockerVolumeMount[];
  records: AgentMaskRecord[];
}

const EMPTY: AgentDefinitionMasks = { mounts: [], records: [] };

/**
 * Masks for the agent directories under the tree this invocation mounts.
 *
 * Returns nothing — never throws — unless `spec.maskAgentDefinitions` is set, so an invocation the
 * dispatcher did not isolate is byte-identical to today.
 */
export async function resolveAgentDefinitionMasks(
  db: Database,
  taskId: string,
  repoMount: DockerVolumeMount | null | undefined,
  spec: { maskAgentDefinitions?: boolean },
): Promise<AgentDefinitionMasks> {
  if (spec.maskAgentDefinitions !== true) return EMPTY;
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { userId: true, repositoryId: true },
    });
    if (!task?.repositoryId) return EMPTY;

    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    if (!repo) return EMPTY;

    const workerRoot = resolveInvocationWorkerRoot({
      repoMountSubpath: repoMount?.subpath,
      storagePath: repo.storagePath ?? repo.localPath,
      userId: task.userId,
      repositoryId: task.repositoryId,
    });
    return await computeAgentDefinitionMasks(workerRoot, repoMount?.target ?? SANDBOX_WORKDIR);
  } catch (err) {
    log.warn({ err, taskId }, 'agent-definition mask scan failed; continuing without it');
    return EMPTY;
  }
}

/**
 * Pure filesystem core (no DB): which agent directories under `workerRoot` exist, as read-only
 * empty tmpfs mounts targeted at `<containerWorkdir>/<dir>`.
 *
 * Only directories that EXIST are masked. A mount over a missing path makes Docker create the
 * mountpoint inside the repo volume, root-owned, and that stub outlives the container: uid-1000
 * writes into it then fail until it is removed. Masking absent candidates would also create
 * directories for CLIs a repository does not use on every isolated run, and on a read-only
 * local-path mount no such mountpoint can be created at all, so an isolated invocation on almost
 * any local-path repository would fail to start.
 *
 * A candidate that IS, or sits under, a repository-controlled symlink is left unmasked: a mount
 * destination that traverses such a link is not a path to hand Docker. Reads no file content, so
 * no race here can leak bytes — the persona reader is the one place that could, and it checks the
 * descriptor it opened.
 */
export async function computeAgentDefinitionMasks(
  workerRoot: string,
  containerWorkdir: string = SANDBOX_WORKDIR,
): Promise<AgentDefinitionMasks> {
  // The mount root can be a worktree, which is never an anchor — the sandbox mounts it read-write.
  // `workspaceAnchor` splits it at the repository root and falls back to the path itself in root
  // mode, which is also what keeps a fixture tree working unchanged.
  const { anchor, prefix } = workspaceAnchor(workerRoot);

  const mounts: DockerVolumeMount[] = [];
  const records: AgentMaskRecord[] = [];
  for (const rel of AGENT_DIRECTORIES) {
    const anchorRel = `${prefix}${rel}`;
    const info = await lstatNoFollow(anchor, anchorRel);
    // Absent, a file, or a symlink: nothing to mask. `lstat` answers for the ENTRY, so a symlinked
    // agents directory reports `symlink` here and is skipped rather than followed — and the walk
    // itself refuses a link in any component of the rel and verifies each held inode through
    // `/proc/self/fd`, so containment is the primitive's guarantee rather than a second check here.
    if (info?.kind !== 'directory') continue;

    mounts.push({
      // A tmpfs has no host side; the branch in buildMountArgs ignores `source` for this form.
      source: '',
      target: posix.join(containerWorkdir, rel),
      tmpfs: true,
      // A write that reaches a masked directory fails loudly instead of vanishing with the
      // container. An isolated invocation declares no file_write, so nothing legitimate writes here.
      readOnly: true,
    });
    records.push({
      rel,
      workerPath: posix.join(workerRoot, rel),
      anchor,
      anchorRel,
      inode: info.stats.ino,
    });
  }

  if (mounts.length > 0) {
    log.info({ workerRoot, masked: records.map((r) => r.rel) }, 'masking agent definitions');
  }
  return { mounts, records };
}

/**
 * Drop every file mask whose target lies under a masked agent directory.
 *
 * The read-only tmpfs already hides that subtree, and Docker cannot create a mountpoint for a file
 * INSIDE a read-only tmpfs — keeping such a mask fails the whole invocation. Dropping one retracts
 * nothing already sent, which is why the dispatch-side persona reader applies the same secret-mask
 * policy before it reads a body.
 */
export function dropMasksUnderAgentDirs(
  maskFiles: SandboxExtraFile[],
  mounts: readonly DockerVolumeMount[],
): SandboxExtraFile[] {
  if (mounts.length === 0) return maskFiles;
  const prefixes = mounts.map((m) => `${m.target}/`);
  return maskFiles.filter((f) => !prefixes.some((p) => f.containerPath.startsWith(p)));
}

/**
 * Remove a stub Docker created for a directory that did not exist before the run.
 *
 * A masked directory that WAS there is left alone, and so is one that now holds anything: an empty
 * root-owned stub is invisible to git, and a later build would mask it as the real directory it has
 * become, while uid-1000 writes into that one path fail until it is removed. Best-effort — a
 * failure logs and leaves the path, which is item 6's fail-open rule.
 *
 * `runtimeUid` is the uid the container ran as (0 for the root-owned stubs Docker leaves). Passed in
 * so a fixture test can exercise the same path with its own uid, since an unprivileged test cannot
 * create a root-owned directory.
 */
export async function removeAgentMaskStubs(
  records: readonly AgentMaskRecord[],
  runtimeUid = 0,
): Promise<void> {
  for (const record of records) {
    try {
      const info = await lstatNoFollow(record.anchor, record.anchorRel);
      if (info?.kind !== 'directory') continue;
      // Still the SAME directory, so it is the repository's own and not a stub. Comparing the inode
      // rather than merely asking whether one was recorded is what makes this REACHABLE at all:
      // every record carries an inode (`computeAgentDefinitionMasks` emits one only for a directory
      // that exists), so the `record.inode !== null` guard this replaced skipped cleanup in every
      // production case — including the one it was written for, where the directory was removed
      // between the scan and container create and Docker recreated the target as an empty stub.
      //
      // The comparison is a cheap early exit and NOT the load-bearing test, because an inode number
      // is reusable: MEASURED on ext2/ext3, a directory removed and immediately recreated in the
      // same parent came back with the identical inode, so a replaced directory can read as
      // unchanged. What separates the two in production is OWNERSHIP — Docker's stub is root-owned
      // while the repository's own directory belongs to the repo owner, and `runtimeUid` is 0 there
      // — together with the emptiness ENOTEMPTY enforces below.
      if (record.inode !== null && info.stats.ino === record.inode) continue;
      if (info.stats.uid !== runtimeUid) continue;
      // Without `recursive` a non-empty directory fails ENOTEMPTY, exactly as `rmdir` does — which
      // IS the check: a stub that now holds something is no longer a stub, and refusing to delete it
      // is the outcome we want rather than one this module has to write. An already-absent path
      // answers false instead of throwing.
      const removed = await removeNoFollow(record.anchor, record.anchorRel);
      if (removed) log.info({ rel: record.rel }, 'removed agent-mask stub left by the container');
    } catch (err) {
      log.warn({ err, rel: record.rel }, 'could not remove agent-mask stub; leaving it in place');
    }
  }
}
