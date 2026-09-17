import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyTreeNoFollow,
  chownNoFollow,
  ensureDirNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
  type EntryInfo,
} from '@haive/shared/fs-safe';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  logger,
  HAIVE_DATA_FILES,
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  type ArchiveFormat,
  type OnboardingEnvironmentMirror,
  type OnboardingExclusionsMirror,
  type OnboardingToolingMirror,
  type RepoJobPayload,
} from '@haive/shared';
import { detectFromDirectory } from './framework-detect.js';
import { importPlanMirror, recordPlanMirrorError } from '../plan/mirror.js';
import { seedBlankScaffold } from './blank-scaffold.js';
import { buildCredentialHelper } from './git-push.js';

export function buildAuthenticatedUrl(url: string, username: string, secret: string): string {
  // Only http(s) carries userinfo. An `ssh://` or scp-style address
  // (`git@host:path`) authenticates with a key handled outside Haive, and an
  // scp address is not a URL at all — `new URL` THROWS on it, which would fail
  // the clone with "Invalid URL" instead of the real problem. Returning it
  // unchanged is what git then does with it, correctly.
  if (!/^https?:\/\//i.test(url)) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(secret);
  return u.toString();
}

/** Clone `url` into `dest`. When `auth` is supplied (an inline git credential
 *  helper from buildCredentialHelper), the token rides in env and git resolves
 *  it per-challenge — so credentials survive a protocol-change redirect (e.g. a
 *  Gitea/nginx http->https 301) that would drop URL-embedded userinfo. */
export function gitClone(
  url: string,
  dest: string,
  branch?: string,
  auth?: { argv: string[]; env: Record<string, string>; secret: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [...(auth?.argv ?? []), 'clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push('--', url, dest);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      ...(auth?.env ?? {}),
    };
    const proc = spawn('git', args, { env });
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
      let msg = stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
      if (auth?.secret) msg = msg.split(auth.secret).join('***');
      reject(new Error(`git clone failed (exit ${code}): ${msg}`));
    });
  });
}

/** Point origin at a (tokenless) URL. Used after a credentialed clone so the
 *  embedded token does not persist in .git/config. */
export function gitSetOriginUrl(dest: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', dest, 'remote', 'set-url', 'origin', url]);
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
      const msg = stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
      reject(new Error(`git remote set-url failed (exit ${code}): ${msg}`));
    });
  });
}

/** Restore onboarding-derived DB state from a repo's committed `.haive-data/`
 *  mirror (written at 12-post-onboarding), so a repo onboarded on one machine
 *  and cloned to another recovers its scope denylist + stack/tooling without
 *  re-running onboarding. Non-clobbering: only fills columns that are currently
 *  NULL, so a live local onboarding (or an earlier import) is never overwritten
 *  and a re-scan/refresh is a no-op once populated. schemaVersion-gated so a
 *  future mirror-format bump is ignored rather than mis-parsed. The tooling
 *  mirror already has the machine-specific infra keys stripped, so consumers on
 *  the new machine fall back to its local defaults. */
async function importHaiveDataMirror(
  db: Database,
  repositoryId: string,
  storagePath: string,
): Promise<void> {
  const [repo] = await db
    .select({
      onboardingEnvironment: schema.repositories.onboardingEnvironment,
      onboardingTooling: schema.repositories.onboardingTooling,
      scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!repo) return;

  const readJson = async <T>(rel: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path.join(storagePath, rel), 'utf8')) as T;
    } catch {
      return null;
    }
  };

  const updates: Partial<{
    onboardingEnvironment: Record<string, unknown>;
    onboardingTooling: Record<string, unknown>;
    scopeExcludeGlobs: string[];
  }> = {};

  if (repo.onboardingEnvironment == null) {
    const env = await readJson<OnboardingEnvironmentMirror>(HAIVE_DATA_FILES.environment);
    if (env?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
      updates.onboardingEnvironment = env as unknown as Record<string, unknown>;
    }
  }
  if (repo.onboardingTooling == null) {
    const tooling = await readJson<OnboardingToolingMirror>(HAIVE_DATA_FILES.tooling);
    if (tooling?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION) {
      updates.onboardingTooling = tooling as unknown as Record<string, unknown>;
    }
  }
  if (repo.scopeExcludeGlobs == null) {
    const excl = await readJson<OnboardingExclusionsMirror>(HAIVE_DATA_FILES.exclusions);
    if (
      excl?.schemaVersion === ONBOARDING_EXCLUSIONS_SCHEMA_VERSION &&
      Array.isArray(excl.scopeExcludeGlobs)
    ) {
      updates.scopeExcludeGlobs = excl.scopeExcludeGlobs;
    }
  }

  if (Object.keys(updates).length === 0) return;
  await db
    .update(schema.repositories)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.repositories.id, repositoryId));
  logger.info(
    { repositoryId, imported: Object.keys(updates) },
    'restored onboarding state from .haive-data mirror',
  );
}

async function persistDetection(
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
  try {
    await importHaiveDataMirror(db, repositoryId, storagePath);
  } catch (err) {
    logger.warn({ err, repositoryId }, 'haive-data mirror import failed (non-fatal)');
  }

  // The plan canvas restores from the same dir but is its own call, not another
  // branch inside importHaiveDataMirror: that function early-returns once it has
  // no repository COLUMNS to fill, and the plan lives in its own tables.
  try {
    const res = await importPlanMirror(db, repositoryId, storagePath);
    if (!res.imported && res.reason && res.reason !== 'no plan mirror') {
      await recordPlanMirrorError(db, repositoryId, `Plan snapshot not imported: ${res.reason}`);
      logger.info({ repositoryId, reason: res.reason }, 'plan mirror not imported');
    }
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
function copyTree(src: string, dest: string): Promise<void> {
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
export async function handleCopyLocal(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.localPath) throw new Error('localPath required for copy job');

  const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
  await mkdir(path.dirname(dest), { recursive: true });
  // Clean dest first so a retry (or a refresh re-copy) starts from scratch
  // instead of merging into a stale tree.
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  await copyTree(payload.localPath, dest);
  await persistDetection(db, payload.repositoryId, dest);
  logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo copy complete');
}

/** uid/gid the extraction tool runs as. NOT 1000: that uid owns every repository on the volume, so a
 *  tool escaping its destination would be writing as the owner of everything it could reach. 65534
 *  (nobody) owns nothing. A worker that is not root cannot setuid at all — CI, and any non-root
 *  deployment — so there it stays the current user, which is no worse than today. */
const EXTRACT_UID = 65534;

/** Spawn an extraction tool with the narrowest environment and identity available.
 *
 *  Two things this fixes, and the env is the bigger one. `spawn(cmd, args)` passes NO `env` option,
 *  so the child inherited the worker's entire environment — which holds `CONFIG_ENCRYPTION_KEY`,
 *  `DATABASE_URL` and `JWT_SECRET` — and it also meant `TAR_OPTIONS`, `UNZIP` and
 *  `EXTRACT_UNSAFE_SYMLINKS` would be honoured if anything ever set them. `PATH` and `LANG` are all
 *  either tool needs. And it ran as root, which is what let a tar archive restore header owners and
 *  setuid bits into storage. */
function runExtract(cmd: string, args: string[], okExits: number[] = [0]): Promise<void> {
  const asRoot = process.getuid?.() === 0;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C' },
      ...(asRoot ? { uid: EXTRACT_UID, gid: EXTRACT_UID } : {}),
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== null && okExits.includes(code)) {
        if (code !== 0) {
          logger.warn(
            { cmd, exit: code, stderr: stderr.trim() },
            'extract completed with warnings',
          );
        }
        resolve();
        return;
      }
      reject(new Error(`${cmd} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** Feed the archive on STDIN, so the parent opens it and the child never resolves a path. Also the
 *  only way tar can read an archive the unprivileged extraction uid cannot open itself. */
function runExtractStdin(cmd: string, args: string[], archivePath: string): Promise<void> {
  const asRoot = process.getuid?.() === 0;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C' },
      ...(asRoot ? { uid: EXTRACT_UID, gid: EXTRACT_UID } : {}),
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} failed (exit ${code}): ${stderr.trim()}`));
    });
    open(archivePath, 'r')
      .then((fh) => {
        const stream = fh.createReadStream({ autoClose: true });
        stream.on('error', reject);
        stream.pipe(proc.stdin!);
      })
      .catch(reject);
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

/**
 * Extract an archive into `dest`, via a private stage, dropping what must not land in a repository
 * tree and reporting it.
 *
 * The old shape extracted STRAIGHT into `dest` after `rm -rf`ing it, as root, with the worker's whole
 * environment inherited. So a malformed archive was unpacked over live repository storage by a root
 * process that also held `CONFIG_ENCRYPTION_KEY` and `DATABASE_URL`. Now:
 *
 * 1. A stage is created as a SIBLING of `dest` — `dirname(dest)` is the trusted directory for all
 *    three callers (`<storage>/<userId>` for a repository, `<root>/<userId>/<bundleId>` for a bundle,
 *    the uploads dir for an attachment), and a sibling is guaranteed to be on the same filesystem, so
 *    the final rename cannot fail EXDEV.
 * 2. The tool runs unprivileged (uid 65534 where the worker is root) with only PATH and LANG, and tar
 *    reads the archive from stdin so the child resolves no path at all.
 * 3. The staged tree is walked and offending members are unlinked and named.
 * 4. Only then is it swapped into place: the old `dest` is moved aside inside the stage, the new tree
 *    renamed in, and the stage removed — so `dest` is never a half-extracted tree, and a failure
 *    anywhere above leaves the previous contents untouched.
 *
 * A cap breach is deliberately NOT handled here: `expand-archives` measures its own limits after this
 * returns and inserts nothing when they are exceeded, because half a specification is worse than none.
 */
export async function extractArchive(
  archivePath: string,
  format: ArchiveFormat,
  dest: string,
): Promise<ExtractReport> {
  if (format !== 'zip' && format !== 'tar' && format !== 'tar.gz') {
    throw new Error(`unsupported archive format: ${format as string}`);
  }
  const anchor = path.dirname(dest);
  const leaf = path.basename(dest);
  await mkdir(anchor, { recursive: true });

  const selfUid = process.getuid?.() ?? null;
  const asRoot = selfUid === 0;
  // What every extracted entry should be owned by: the tool's own uid, since a non-root tar cannot
  // restore header owners. An entry owned by anything else did not come from the extraction.
  const expectedUid = asRoot ? EXTRACT_UID : selfUid;

  const stageLeaf = `.haive-extract-${process.pid}-${randomUUID()}`;
  await ensureDirNoFollow(anchor, stageLeaf, { mode: 0o700 });
  try {
    const innerRel = `${stageLeaf}/x`;
    await ensureDirNoFollow(anchor, innerRel, { mode: 0o755 });
    if (asRoot) {
      await chownNoFollow(anchor, innerRel, { uid: EXTRACT_UID, gid: EXTRACT_UID });
    }
    const innerAbs = path.join(anchor, innerRel);

    if (format === 'zip') {
      // unzip needs a seekable file, so it gets the path — and the archive has to be readable by the
      // extraction uid. Best-effort: it is our own upload, and 0644 is what the api already writes.
      await chmod(archivePath, 0o644).catch(() => {});
      // exit 1 = warnings only (a non-ASCII filename header mismatch); files are still extracted.
      await runExtract('unzip', ['-q', '-o', archivePath, '-d', innerAbs], [0, 1]);
    } else {
      const flags = format === 'tar.gz' ? ['-xz'] : ['-x'];
      await runExtractStdin('tar', [...flags, '-f', '-', '-C', innerAbs], archivePath);
    }

    const dropped = await validateStagedTree(anchor, innerRel, expectedUid);

    // `spec.zip` holding a single `spec/` becomes that directory's contents. Only a REAL directory is
    // flattened, and the flatten is now a choice of rename SOURCE rather than a move of each child.
    let sourceRel = innerRel;
    const top = (await readdirNoFollow(anchor, innerRel)) ?? [];
    if (top.length === 1) {
      const only = top[0]!.name;
      const info = await lstatNoFollow(anchor, `${innerRel}/${only}`);
      if (info?.kind === 'directory') sourceRel = `${innerRel}/${only}`;
    }

    // Hand the tree back to the worker's identity while it is still private, so the swapped result
    // is owned exactly as it was before this change. Best-effort: a non-root worker cannot, and the
    // sandbox ownership repair runs later anyway.
    if (asRoot) {
      await applyTreeNoFollow(anchor, sourceRel, { owner: { uid: 0, gid: 0 } }).catch(
        () => undefined,
      );
    }

    if ((await lstatNoFollow(anchor, leaf)) !== null) {
      await renameNoFollow(anchor, leaf, `${stageLeaf}/old`);
    }
    await renameNoFollow(anchor, sourceRel, leaf);
    return { dropped, note: describeDrops(dropped) };
  } finally {
    await removeNoFollow(anchor, stageLeaf, {
      recursive: true,
      repairPermissions: true,
    }).catch(() => undefined);
  }
}

export async function handleExtract(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.archivePath) throw new Error('archivePath required for extract job');
  if (!payload.archiveFormat) throw new Error('archiveFormat required for extract job');

  const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
  const report = await extractArchive(payload.archivePath, payload.archiveFormat, dest);
  if (report.note) {
    logger.warn({ repositoryId: payload.repositoryId, dropped: report.dropped }, report.note);
  }
  await persistDetection(db, payload.repositoryId, dest, report.note);
  // Only remove the archive after successful extract + detection. Leaving it
  // in place on failure lets the user (or a retry) look at what actually
  // arrived on disk instead of silently masking the error.
  await rm(payload.archivePath, { force: true }).catch(() => {});
  logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo extract complete');
}

/** Run a git command in `cwd`, rejecting on a non-zero exit. Local-only (no
 *  network, no credentials), so unlike gitClone there is nothing to redact. */
function gitRun(cwd: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', cwd, ...args], { env: { ...process.env, ...(env ?? {}) } });
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
      reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
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
}

export async function handleClone(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.remoteUrl) throw new Error('remoteUrl required for clone job');

  const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });

  // Authenticate via the inline credential helper (same mechanism as push), NOT
  // by embedding the token in the URL. URL userinfo is dropped by curl across a
  // protocol-change redirect (a Gitea/nginx http->https 301 returns "remote:
  // Unauthorized"); the helper is resolved against the challenge's host, so it
  // survives the redirect. It also keeps the token out of .git/config, so the
  // cloned origin is already the plain URL — no post-clone reset needed.
  const auth = payload.credentialsId
    ? await buildCredentialHelper(db, payload.credentialsId, payload.userId)
    : undefined;

  await gitClone(payload.remoteUrl, dest, payload.branch, auth);
  await persistDetection(db, payload.repositoryId, dest);
  logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo clone complete');
}
