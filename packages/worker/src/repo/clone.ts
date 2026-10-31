import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyTreeNoFollow,
  chownNoFollow,
  ensureDirNoFollow,
  lstatNoFollow,
  openDirNoFollow,
  openFileNoFollow,
  readdirNoFollow,
  readFileNoFollow,
  removeNoFollow,
  renameNoFollow,
  type EntryInfo,
} from '@haive/shared/fs-safe';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  acquireRootClaim,
  readLiveRootClaim,
  schema,
  type Database,
  type RootClaimKind,
} from '@haive/database';
import {
  logger,
  CHECKOUT_HOLDING_TASK_STATUSES,
  HAIVE_DATA_FILES,
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  mirroredEnvDetectData,
  type ArchiveFormat,
  type OnboardingEnvironmentMirror,
  type OnboardingExclusionsMirror,
  type OnboardingToolingMirror,
  type RepoJobPayload,
} from '@haive/shared';
import { convergeRtkQuestion } from '@haive/shared/rtk-enabled';
import { isAllowedGitRemoteUrl, redactGitUrl } from '@haive/shared/schemas';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import {
  ENVIRONMENT_UNIT,
  PROJECT_STATE_DIR,
  TOOLING_UNIT_NAME,
  isRtkChoiceRecorded,
  readRenderContextColumn,
  settingFileName,
  withoutMachineLocalTooling,
} from '@haive/shared/project-state';
import { detectFromDirectory } from './framework-detect.js';
import { holdImportedMcpServers } from '../sandbox/mcp-config.js';
import { syncPlanFromCheckout } from '../plan/sync-checkout.js';
import { syncProjectStateFromCheckout } from '../project-state/sync.js';
import { raiseRtkQuestion } from '../project-state/rtk-conflict.js';
import { seedBlankScaffold } from './blank-scaffold.js';
import { buildCredentialHelper, OriginUrlError, scrubSecret } from './git-push.js';
import { EXTRACT_UID, FIRST_SLOT, childFd, runTool, toolReadable } from './tool-spawn.js';
import { splitUploadPath } from './worktree-paths.js';
import { gitRun as boundedGitRun } from './git-exec.js';

/** Clone `url` into `dest`. When `auth` is supplied (an inline git credential
 *  helper from buildCredentialHelper), the token rides in env and git resolves
 *  it per-challenge, restricted to the stored remote host and protocol. */
export async function gitClone(
  url: string,
  dest: string,
  branch?: string,
  auth?: { argv: string[]; env: Record<string, string>; secret: string },
): Promise<void> {
  assertCloneUrl(url);
  const args = [...(auth?.argv ?? []), 'clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push('--', redactGitUrl(url, true), dest);
  // The destination does not exist yet: run in the worker's cwd, as spawn did,
  // while keeping the shared deadline, hardening and no-exit result contract.
  const result = await boundedGitRun(process.cwd(), args, {
    GIT_ASKPASS: 'echo',
    ...(auth?.env ?? {}),
  });
  if (result.code !== 0) {
    const msg = scrubSecret(result.stderr, auth?.secret ?? null).trim();
    throw new Error(`git clone failed (exit ${result.code}): ${msg}`);
  }
}

/** Legacy database rows cross the same URL boundary as newly submitted remotes. */
export function assertCloneUrl(
  url: string,
  context: 'clone' | 'refresh' | 'bundle' = 'clone',
): void {
  if (!isAllowedGitRemoteUrl(url)) throw new OriginUrlError(url, 'fetch', context);
}

const MIRROR_READ_CAP = 1024 * 1024;

/** Restore onboarding-derived DB state from a repo's committed `.haive-data/`
 *  mirror (written at 12-post-onboarding), so a repo onboarded on one machine
 *  and cloned to another recovers its scope denylist + stack/tooling without
 *  re-running onboarding. A unit the project state record carries (the environment, the scope
 *  denylist, the tooling) is left to the sync that imports the record, whatever a stale legacy file holds; the
 *  call returns true when it left one, and `afterSync` repeats it as the fallback for a column the
 *  sync did not fill. Non-clobbering: only fills columns that are currently
 *  NULL, so a live local onboarding (or an earlier import) is never overwritten
 *  and a re-scan/refresh is a no-op once populated. schemaVersion-gated so a
 *  future mirror-format bump is ignored rather than mis-parsed. A committed
 *  tooling file never chooses this install's machine-specific keys (RAG connection, Ollama
 *  endpoint, MCP consent): they are dropped on import whatever the file holds. */
async function importHaiveDataMirror(
  db: Database,
  repositoryId: string,
  storagePath: string,
  afterSync = false,
): Promise<boolean> {
  const [repo] = await db
    .select({
      onboardingEnvironment: schema.repositories.onboardingEnvironment,
      onboardingTooling: schema.repositories.onboardingTooling,
      scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
      rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
      renderContext: schema.repositories.renderContext,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!repo) return false;

  const readJson = async <T>(rel: string): Promise<T | null> => {
    const read = await readFileNoFollow(storagePath, rel, { maxBytes: MIRROR_READ_CAP }).catch(
      () => null,
    );
    if (!read || read.truncated) return null;
    try {
      return JSON.parse(read.data.toString('utf8')) as T;
    } catch {
      return null;
    }
  };

  const updates: Partial<{
    onboardingEnvironment: Record<string, unknown>;
    onboardingTooling: Record<string, unknown>;
    rtkEnabled: boolean;
    scopeExcludeGlobs: string[];
  }> = {};

  let deferred = false;
  const recordHolds = async (unit: string): Promise<boolean> => {
    if (afterSync) return false;
    const holds = (await lstatNoFollow(storagePath, `${PROJECT_STATE_DIR}/${unit}`)) !== null;
    if (holds) deferred = true;
    return holds;
  };

  if (repo.onboardingEnvironment == null && !(await recordHolds(ENVIRONMENT_UNIT))) {
    const env = await readJson<OnboardingEnvironmentMirror>(HAIVE_DATA_FILES.environment);
    if (env?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
      const data = env.envDetectData as unknown;
      // An older release committed 01's prompt-only fields here.
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        env.envDetectData = mirroredEnvDetectData(data as Record<string, unknown>);
      }
      updates.onboardingEnvironment = env as unknown as Record<string, unknown>;
    }
  }
  const column = readRenderContextColumn(repo.renderContext);
  const rtkChoiceRecorded = column.kind === 'column' && column.column.rtkChoiceRecorded;
  let heldMcpServers: unknown = null;
  if (repo.onboardingTooling == null && !(await recordHolds(settingFileName(TOOLING_UNIT_NAME)))) {
    const tooling = await readJson<OnboardingToolingMirror>(HAIVE_DATA_FILES.tooling);
    if (tooling?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION) {
      const incoming = tooling.tooling;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        const local = withoutMachineLocalTooling(incoming);
        const held = holdImportedMcpServers(local);
        heldMcpServers = held?.importedMcpServerNames ?? null;
        tooling.tooling = held ?? local;
        if (
          typeof local.rtkEnabled === 'boolean' &&
          !isRtkChoiceRecorded(rtkChoiceRecorded, repo.rtkChoiceMadeAt)
        ) {
          updates.rtkEnabled = local.rtkEnabled;
        }
      }
      updates.onboardingTooling = tooling as unknown as Record<string, unknown>;
    }
  }
  if (
    repo.scopeExcludeGlobs == null &&
    !(await recordHolds(settingFileName('scope-exclude-globs')))
  ) {
    const excl = await readJson<OnboardingExclusionsMirror>(HAIVE_DATA_FILES.exclusions);
    if (
      excl?.schemaVersion === ONBOARDING_EXCLUSIONS_SCHEMA_VERSION &&
      Array.isArray(excl.scopeExcludeGlobs)
    ) {
      updates.scopeExcludeGlobs = excl.scopeExcludeGlobs;
    }
  }

  if (Object.keys(updates).length === 0) return deferred;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.repositories)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.repositories.id, repositoryId));
    if (updates.rtkEnabled === false) await convergeRtkQuestion(tx, repositoryId, null);
    if (
      updates.scopeExcludeGlobs !== undefined ||
      updates.rtkEnabled !== undefined ||
      updates.onboardingEnvironment !== undefined ||
      updates.onboardingTooling !== undefined
    ) {
      await markProjectStateDirty(tx, repositoryId);
    }
  });
  logger.info(
    { repositoryId, imported: Object.keys(updates) },
    'restored onboarding state from .haive-data mirror',
  );
  if (heldMcpServers) {
    logger.warn(
      { repositoryId, servers: heldMcpServers },
      'imported MCP servers held until accepted on this install',
    );
  }
  return deferred;
}

export async function persistDetection(
  db: Database,
  repositoryId: string,
  storagePath: string,
  /** Carried into `status_message` beside `status: 'ready'`. The repository IS ready — this is the
   *  "ready, with caveats" case, and the column exists for exactly that. */
  statusMessage?: string | null,
): Promise<void> {
  const detection = await detectFromDirectory(storagePath);
  await db
    .update(schema.repositories)
    .set({
      fileTree: detection.fileTree,
      detectedFramework: detection.framework,
      detectedLanguages: detection.languages,
      sizeBytes: detection.sizeBytes,
      storagePath,
      status: 'ready',
      // `null` when this import dropped nothing, so a clean re-import CLEARS a previous run's note
      // rather than leaving the repository labelled with a caveat that no longer applies.
      statusMessage: statusMessage ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, repositoryId));

  // Best-effort: a fresh clone of an already-onboarded repo restores its
  // onboarding-derived columns from the committed .haive-data/ mirror. Never
  // fail the scan/clone over a missing or malformed mirror.
  let legacyDeferred = false;
  try {
    legacyDeferred = await importHaiveDataMirror(db, repositoryId, storagePath);
  } catch (err) {
    logger.warn({ err, repositoryId }, 'haive-data mirror import failed (non-fatal)');
  }

  try {
    const synced = await syncProjectStateFromCheckout(db, {
      repositoryId,
      repoPath: storagePath,
    });
    logger.info(
      { repositoryId, outcome: synced.outcome, reason: synced.reason },
      'project state record synced from the checkout',
    );
  } catch (err) {
    logger.warn({ err, repositoryId }, 'project state sync failed (non-fatal)');
  }

  if (legacyDeferred) {
    try {
      await importHaiveDataMirror(db, repositoryId, storagePath, true);
    } catch (err) {
      logger.warn({ err, repositoryId }, 'haive-data mirror fallback import failed (non-fatal)');
    }
  }

  // After the sync and the fallback import: they supply the tooling and the choice it weighs.
  try {
    await raiseRtkQuestion(db, repositoryId);
  } catch (err) {
    logger.warn({ err, repositoryId }, 'RTK question not raised (non-fatal)');
  }

  // The plan canvas restores from the same dir but is its own call, not another
  // branch inside importHaiveDataMirror: that function early-returns once it has
  // no repository COLUMNS to fill, and the plan lives in its own tables.
  try {
    await syncPlanFromCheckout(db, repositoryId, storagePath);
  } catch (err) {
    logger.warn({ err, repositoryId }, 'plan mirror import failed (non-fatal)');
  }
}

export async function handleScan(payload: RepoJobPayload, db: Database): Promise<void> {
  if (!payload.localPath) throw new Error('localPath required for scan job');
  await persistDetection(db, payload.repositoryId, payload.localPath);
  logger.info({ repositoryId: payload.repositoryId }, 'Repo scan complete');
}

/** Recursively copy a directory's full contents (dotfiles like .git plus any
 *  uncommitted/untracked working-tree changes) into dest, preserving
 *  permissions, symlinks, and timestamps. `cp -a src/. dest` copies the
 *  *contents* of src instead of nesting src under its basename. Symlinks are
 *  preserved as-is (not followed), so a symlink in the user's tree cannot leak
 *  a host file into the volume during the copy. */
export function copyTree(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cp', ['-a', `${src}/.`, dest]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`cp -a failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** Writable-local import: copy the user's working tree from the host bind
 *  (/host-fs/...) into the haive_repos volume so the workflow gets a writable
 *  snapshot. Unlike handleScan — which leaves storagePath under /host-fs where
 *  the sandbox binds it read-only — this points storagePath into the volume,
 *  so every downstream resolver treats it as a writable volume repo. The copy
 *  is a one-time snapshot taken at import (a later refresh re-copies). */
/**
 * Take the root claim for a rebuild, run the destructive work, and release it.
 *
 * HELD across the work rather than checked before it, and that is the whole correctness argument.
 * A one-time check leaves the window where this handler has already passed it and a reset claims
 * the row before `rm(dest)` runs — at which point the reset derives provenance and deletes files
 * while the tree is being recursively removed underneath it. Holding the same claim the reset
 * takes makes the two mutually exclusive: whichever arrives second is refused.
 *
 * Throwing on a refusal is the right shape, not a silent return: the repo queue runs `attempts: 3`
 * with exponential backoff, so a reset lasting seconds is simply waited out, and one that outlives
 * the retries parks the row at `error` carrying this message. A silent return would leave the row
 * `cloning` for good, since it is `persistDetection` at the end of a SUCCESSFUL run that writes
 * `ready`.
 */
export async function withRootClaim<T>(
  db: Database,
  repositoryId: string,
  run: () => Promise<T>,
  kind: RootClaimKind = 'rebuild',
): Promise<T> {
  const claim = await acquireRootClaim(db, repositoryId, kind);
  if (claim === null) {
    const held = await readLiveRootClaim(db, repositoryId);
    throw new Error(
      `the repository root is claimed (${held?.kind ?? 'unknown'}); it must not be rebuilt until that finishes`,
    );
  }
  try {
    return await run();
  } finally {
    await claim.release().catch(() => undefined);
    // Not thrown: the tree has already been rewritten, and failing here hands the job back to
    // BullMQ's `attempts: 3`, which re-runs the clone and puts a THIRD writer on it. Logged at
    // error so the one case where two writers touched one root is findable afterwards.
    if (claim.lost()) {
      logger.error(
        { repositoryId },
        'root claim was taken over while this job was still rewriting the tree; ' +
          'another writer may have run against the same repository root',
      );
    }
  }
}

export async function handleCopyLocal(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.localPath) throw new Error('localPath required for copy job');
  const localPath = payload.localPath;
  return withRootClaim(db, payload.repositoryId, async () => {
    const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
    await mkdir(path.dirname(dest), { recursive: true });
    // Clean dest first so a retry (or a refresh re-copy) starts from scratch
    // instead of merging into a stale tree.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });

    await copyTree(localPath, dest);
    await persistDetection(db, payload.repositoryId, dest);
    logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo copy complete');
  });
}

export type DroppedReason = 'symlink' | 'special-file' | 'setuid' | 'hard-link' | 'foreign-owner';

export interface DroppedMember {
  /** Path relative to the extracted root. */
  rel: string;
  reason: DroppedReason;
}

export interface ExtractReport {
  dropped: DroppedMember[];
  /** One line naming what was dropped, or null when nothing was. Callers SURFACE this: a drop that
   *  only reaches a log is a silent change to what the user uploaded. */
  note: string | null;
}

const DROP_LABEL: Record<DroppedReason, string> = {
  symlink: 'symlink(s)',
  'special-file': 'device/socket/FIFO entr(y/ies)',
  setuid: 'setuid/setgid file(s)',
  'hard-link': 'hard link(s)',
  'foreign-owner': 'entr(y/ies) with an unexpected owner',
};

function describeDrops(dropped: DroppedMember[]): string | null {
  if (dropped.length === 0) return null;
  const counts = new Map<DroppedReason, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const summary = [...counts].map(([reason, n]) => `${n} ${DROP_LABEL[reason]}`).join(', ');
  const shown = dropped.slice(0, 5).map((d) => d.rel);
  const more = dropped.length > shown.length ? ` and ${dropped.length - shown.length} more` : '';
  return `${dropped.length} archive member(s) were not extracted (${summary}): ${shown.join(', ')}${more}`;
}

/** What an extracted entry must not be. Everything here is dropped and NAMED rather than refusing
 *  the whole archive — the user gets their upload, minus the parts that cannot safely live in a
 *  repository tree, and is told which. */
function classifyMember(info: EntryInfo, expectedUid: number | null): DroppedReason | null {
  if (info.kind === 'symlink') return 'symlink';
  // FIFOs, sockets and device nodes. Root tar restores device nodes verbatim, and a FIFO makes any
  // later path-based read of the tree block forever.
  if (info.kind === 'other') return 'special-file';
  if (info.kind === 'file') {
    if ((info.stats.mode & 0o6000) !== 0) return 'setuid';
    // A hard link to a file outside the tree is indistinguishable from one inside it after the
    // fact, so extra links are dropped rather than reasoned about.
    if (info.stats.nlink > 1) return 'hard-link';
  }
  if (expectedUid !== null && info.stats.uid !== expectedUid) return 'foreign-owner';
  return null;
}

/** Walk the staged tree, unlinking what must not survive. Anchored, so every component is resolved
 *  inside a descriptor this process holds — the tree being walked is untrusted by construction. */
async function validateStagedTree(
  anchor: string,
  rootRel: string,
  expectedUid: number | null,
): Promise<DroppedMember[]> {
  const dropped: DroppedMember[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const dirRel = pending.pop()!;
    const entries = await readdirNoFollow(anchor, dirRel === '' ? rootRel : `${rootRel}/${dirRel}`);
    if (entries === null) continue;
    for (const entry of entries) {
      const childRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      const info = await lstatNoFollow(anchor, `${rootRel}/${childRel}`);
      if (info === null) continue;
      const reason = classifyMember(info, expectedUid);
      if (reason !== null) {
        await removeNoFollow(anchor, `${rootRel}/${childRel}`, { recursive: true });
        dropped.push({ rel: childRel, reason });
        continue;
      }
      if (info.kind === 'directory') pending.push(childRel);
    }
  }
  return dropped;
}

class MissingArchiveError extends Error {
  constructor() {
    super('Archive is missing on disk');
  }
}

/**
 * Extract an archive into `dest`, via a private stage, dropping what must not land in a repository
 * tree and reporting it.
 *
 * The old shape extracted STRAIGHT into `dest` after `rm -rf`ing it, as root, with the worker's whole
 * environment inherited. So a malformed archive was unpacked over live repository storage by a root
 * process that also held `CONFIG_ENCRYPTION_KEY` and `DATABASE_URL`. Now:
 *
 * 1. The archive is opened first, without following a link anywhere on its way, so an archive that
 *    is refused leaves nothing behind. Both paths are an anchor the caller trusts and a rel walked
 *    below it one held directory at a time.
 * 2. A 0700 stage is created as a SIBLING of `dest`, which is guaranteed to be on the same
 *    filesystem, so the final rename cannot fail EXDEV.
 * 3. The tool runs unprivileged (uid 65534 where the worker is root) with only PATH and LANG, and is
 *    handed the stage's `x` and the archive as descriptors (`runTool`). It resolves no path of the
 *    worker's by name, which is also why it never has to traverse the stage.
 * 4. The staged tree is walked and offending members are unlinked and named.
 * 5. Only then is it swapped into place: the old `dest` is moved aside inside the stage, the new tree
 *    renamed in, and the stage removed — so `dest` is never a half-extracted tree. Failures before
 *    the swap leave its previous contents untouched; if the new tree cannot be renamed in, `dest` is restored.
 *    If restoration also fails, the old tree is retained at the logged absolute `oldPath` instead of deleted.
 *    A crash between the two renames leaves `dest` absent and the old tree in the sibling
 *    `.haive-extract-<pid>-<uuid>/old`; in-process rollback cannot run after a crash.
 *
 * A cap breach is deliberately NOT handled here: `expand-archives` measures its own limits after this
 * returns and inserts nothing when they are exceeded, because half a specification is worse than none.
 */
export async function extractArchive(
  archive: { anchor: string; rel: string },
  format: ArchiveFormat,
  dest: { anchor: string; rel: string },
  opts: { keepLoneDir?: (name: string) => boolean } = {},
): Promise<ExtractReport> {
  if (format !== 'zip' && format !== 'tar' && format !== 'tar.gz') {
    throw new Error(`unsupported archive format: ${format as string}`);
  }
  const { anchor } = dest;
  const cut = dest.rel.lastIndexOf('/');
  const parentRel = cut === -1 ? '' : dest.rel.slice(0, cut);
  const within = (leaf: string): string => (parentRel === '' ? leaf : `${parentRel}/${leaf}`);

  const selfUid = process.getuid?.() ?? null;
  const asRoot = selfUid === 0;
  // What every extracted entry should be owned by: the tool's own uid, since a non-root tar cannot
  // restore header owners. An entry owned by anything else did not come from the extraction.
  const expectedUid = asRoot ? EXTRACT_UID : selfUid;

  const held = await openFileNoFollow(archive.anchor, archive.rel, 'read', { strict: true });
  if (!held) throw new MissingArchiveError();
  try {
    if (parentRel !== '') await ensureDirNoFollow(anchor, parentRel);
    const stageRel = within(`.haive-extract-${process.pid}-${randomUUID()}`);
    await ensureDirNoFollow(anchor, stageRel, { mode: 0o700 });
    let preserveStage = false;
    try {
      const innerRel = `${stageRel}/x`;
      await ensureDirNoFollow(anchor, innerRel, { mode: 0o755 });
      if (asRoot) {
        await chownNoFollow(anchor, innerRel, { uid: EXTRACT_UID, gid: EXTRACT_UID });
      }
      const inner = await openDirNoFollow(anchor, innerRel);
      try {
        if (format === 'zip') {
          // unzip seeks, so it re-opens the archive through its slot instead of reading a stream.
          const readable = await toolReadable(held);
          try {
            // exit 1 = warnings only (a non-ASCII filename header mismatch); files are still
            // extracted.
            const { exitCode, stderr } = await runTool(
              'unzip',
              ['-q', '-o', childFd(FIRST_SLOT + 1), '-d', childFd(FIRST_SLOT)],
              { fds: [inner, readable.fh], okExits: [0, 1] },
            );
            if (exitCode !== 0) {
              logger.warn(
                { cmd: 'unzip', exit: exitCode, stderr: stderr.trim() },
                'extract completed with warnings',
              );
            }
          } finally {
            await readable.close();
          }
        } else {
          const flags = format === 'tar.gz' ? ['-xz'] : ['-x'];
          await runTool('tar', [...flags, '-f', '-', '-C', childFd(FIRST_SLOT)], {
            fds: [inner],
            stdin: held,
          });
        }
      } finally {
        await inner.close();
      }

      const dropped = await validateStagedTree(anchor, innerRel, expectedUid);

      // `spec.zip` holding a single `spec/` becomes that directory's contents. Only a REAL directory
      // is flattened, and the flatten is a choice of rename SOURCE rather than a move of each child.
      let sourceRel = innerRel;
      const top = (await readdirNoFollow(anchor, innerRel)) ?? [];
      if (top.length === 1) {
        const only = top[0]!.name;
        const info = await lstatNoFollow(anchor, `${innerRel}/${only}`);
        if (info?.kind === 'directory' && !opts.keepLoneDir?.(only)) {
          sourceRel = `${innerRel}/${only}`;
        }
      }

      // Hand the tree back to the worker's identity while it is still private, so the swapped result
      // is owned exactly as it was before this change. Best-effort: a non-root worker cannot, and the
      // sandbox ownership repair runs later anyway.
      if (asRoot) {
        await applyTreeNoFollow(anchor, sourceRel, { owner: { uid: 0, gid: 0 } }).catch(
          () => undefined,
        );
      }

      const oldRel = `${stageRel}/old`;
      const hadDest = (await lstatNoFollow(anchor, dest.rel)) !== null;
      if (hadDest) {
        await renameNoFollow(anchor, dest.rel, oldRel);
      }
      try {
        await renameNoFollow(anchor, sourceRel, dest.rel);
      } catch (err) {
        if (hadDest) {
          try {
            await renameNoFollow(anchor, oldRel, dest.rel);
          } catch (restoreErr) {
            preserveStage = true;
            logger.error(
              {
                err: restoreErr,
                anchor,
                dest: dest.rel,
                oldRel,
                oldPath: path.join(anchor, oldRel),
              },
              'archive swap rollback failed; previous destination retained in stage',
            );
          }
        }
        throw err;
      }
      return { dropped, note: describeDrops(dropped) };
    } finally {
      if (!preserveStage) {
        await removeNoFollow(anchor, stageRel, {
          recursive: true,
          repairPermissions: true,
        }).catch((err: unknown) => {
          logger.warn(
            { err, anchor, stageRel, stagePath: path.join(anchor, stageRel) },
            'archive extraction stage was not removed',
          );
        });
      }
    }
  } finally {
    await held.close();
  }
}

export async function handleExtract(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.archivePath) throw new Error('archivePath required for extract job');
  if (!payload.archiveFormat) throw new Error('archiveFormat required for extract job');
  const archive = splitUploadPath(repoStorageRoot, payload.archivePath);
  if (!archive) throw new Error('archivePath is not an upload in the repository storage');
  const archiveFormat = payload.archiveFormat;

  // Claimed like the three that `rm -rf`, because it destroys the root just as thoroughly by a
  // different verb: `extractArchive` renames the existing tree aside and renames the new one into
  // its place. Keying the audit on `rm(dest)` missed this one — the property that matters is
  // "replaces the repository root", not which call does it.
  return withRootClaim(db, payload.repositoryId, async () => {
    const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
    const holding = await db.query.tasks.findMany({
      where: and(
        eq(schema.tasks.repositoryId, payload.repositoryId),
        inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        isNull(schema.tasks.deadAt),
      ),
      columns: { id: true },
    });
    if (holding.length > 0)
      throw new Error('A task is using this repository. Retry once it finishes.');
    const report = await extractArchive(archive, archiveFormat, {
      anchor: repoStorageRoot,
      rel: `${payload.userId}/${payload.repositoryId}`,
    }).catch(async (err: unknown) => {
      if (!(err instanceof MissingArchiveError)) throw err;
      // Cancel only this completed source, never an in-progress upload or another user's row.
      // The list can then hide Retry without interpreting status_message or probing the disk.
      await db
        .update(schema.repoUploads)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(schema.repoUploads.id, payload.repositoryId),
            eq(schema.repoUploads.userId, payload.userId),
            eq(schema.repoUploads.archivePath, payload.archivePath!),
            eq(schema.repoUploads.status, 'complete'),
          ),
        );
      throw new Error(
        'The uploaded archive is no longer available. Delete this repository and upload it again.',
      );
    });
    if (report.note) {
      logger.warn({ repositoryId: payload.repositoryId, dropped: report.dropped }, report.note);
    }
    await persistDetection(db, payload.repositoryId, dest, report.note);
    // Only remove the archive after successful extract + detection. Leaving it
    // in place on failure lets the user (or a retry) look at what actually
    // arrived on disk instead of silently masking the error.
    await removeNoFollow(archive.anchor, archive.rel).catch((err: unknown) => {
      logger.warn(
        { err, repositoryId: payload.repositoryId, rel: archive.rel },
        'extracted repository archive was not removed',
      );
    });
    logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo extract complete');
  });
}

/** Run a git command in `cwd`, rejecting on a non-zero exit. Local-only (no
 *  network, no credentials), so unlike gitClone there is nothing to redact. */
async function gitRun(cwd: string, args: string[], env?: Record<string, string>): Promise<void> {
  const result = await boundedGitRun(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
}

/** Identity for the seed commit. `git init` inherits no user config inside the
 *  worker container, and `git commit` hard-fails without one. Matches the
 *  fallback the step-engine commit paths use. */
const INIT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

/** Greenfield `blank` source: create the repo's storage dir, `git init` it and
 *  land one commit so it has a HEAD. Everything repo-anchored downstream —
 *  `01-worktree-setup` (which needs a commit to branch from), task attachments
 *  (which need `storagePath`), the `.haive-data/` mirror — then works on a
 *  project that does not exist yet. Ends by calling persistDetection so the row
 *  lands `ready` through the same path as clone/scan/copy; detection over a
 *  one-file tree simply finds no framework. */
export async function handleInit(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  return withRootClaim(db, payload.repositoryId, async () => {
    const [row] = await db
      .select({ name: schema.repositories.name })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, payload.repositoryId))
      .limit(1);
    const repoName = row?.name ?? 'project';

    const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
    await mkdir(path.dirname(dest), { recursive: true });
    // Clean first so a retry starts from scratch rather than re-initialising over
    // a half-written tree.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });

    const branch = payload.branch?.trim() || 'main';
    await gitRun(dest, ['init', '--initial-branch', branch]);
    await writeFile(
      path.join(dest, 'README.md'),
      `# ${repoName}\n\nCreated by Haive as a blank project.\n`,
      'utf8',
    );
    // The deterministic half of onboarding, up front. A blank project has nothing
    // to mine a knowledge base from, but the agent specs, skills and workflow
    // config never depended on the code — so a repo created empty arrives able to
    // run a task instead of demanding an onboarding pass over an empty tree.
    // Best-effort: a scaffold that cannot be rendered must not sink the whole
    // init, which would leave the user with no repository at all.
    let scaffold: string[] = [];
    try {
      scaffold = await seedBlankScaffold(
        db,
        { userId: payload.userId, repositoryId: payload.repositoryId, repoName: row?.name ?? null },
        dest,
      );
    } catch (err) {
      logger.warn({ err, repositoryId: payload.repositoryId }, 'blank scaffold seeding failed');
    }

    // Committed WITH the README rather than left staged: a repository the user has
    // just created should not open on a diff they did not write.
    await gitRun(dest, ['add', '--', 'README.md', ...scaffold]);
    await gitRun(dest, ['commit', '-m', 'chore: initialise blank repository'], INIT_GIT_IDENTITY);

    await persistDetection(db, payload.repositoryId, dest);
    logger.info({ repositoryId: payload.repositoryId, dest, branch }, 'Blank repo init complete');
  });
}

export async function handleClone(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.remoteUrl) throw new Error('remoteUrl required for clone job');
  const remoteUrl = redactGitUrl(payload.remoteUrl, true);
  assertCloneUrl(remoteUrl);
  return withRootClaim(db, payload.repositoryId, async () => {
    const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
    await mkdir(path.dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });

    // Authenticate via the inline credential helper (same mechanism as push), NOT
    // by embedding the token in the URL. Each challenge must match the bound
    // remote's host and protocol. This keeps the token out of .git/config, so the
    // cloned origin is already the plain URL — no post-clone reset needed.
    const auth = payload.credentialsId
      ? await buildCredentialHelper(db, payload.credentialsId, payload.userId, remoteUrl)
      : undefined;

    await gitClone(remoteUrl, dest, payload.branch, auth);
    await persistDetection(db, payload.repositoryId, dest);
    logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo clone complete');
  });
}
