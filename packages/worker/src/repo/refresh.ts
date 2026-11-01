import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  readFileNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';
import { lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger, type RepoJobPayload } from '@haive/shared';
import { assertCloneUrl, copyTree, gitClone, persistDetection, withRootClaim } from './clone.js';
import {
  MOVE_ATTEMPTS,
  putBackAfterFailure,
  putBackProjections,
  recoverAfterMoveFailure,
  restoreKeptMetadata,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
  type KeptFiles,
} from '../project-state/set-aside.js';
import { headCommit } from '../plan/merge.js';
import { seedPlanBaseFromCheckout } from '../plan/mirror.js';
import { handBackAfterMove } from '../step-engine/git-merge.js';
import { GitOperationUnreadableError } from './git-operation.js';
import { GIT_TIMED_OUT, gitGaveNoAnswer, type GitRunResult } from './git-exec.js';
import {
  buildCredentialHelper,
  detectOrigin,
  gitRun,
  originGitRun,
  scrubSecret,
} from './git-push.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Tasks holding this repository's checkout right now. `rootOnly` counts only tasks with no worktree of
 *  their own, which work in the checkout itself; `excludeTaskId` leaves out the caller's task. */
export async function checkoutHoldingTasks(
  db: Pick<Database, 'query'>,
  repositoryId: string,
  opts: { excludeTaskId?: string; rootOnly?: boolean } = {},
): Promise<number> {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
      isNull(schema.tasks.deadAt),
      opts.excludeTaskId ? ne(schema.tasks.id, opts.excludeTaskId) : undefined,
      opts.rootOnly ? isNull(schema.tasks.worktreePath) : undefined,
    ),
    columns: { id: true },
  });
  return rows.length;
}

const holdingRefusal = (holding: number): string =>
  `Not refreshed: ${plural(holding, 'task')} ${holding === 1 ? 'is' : 'are'} using this repository. Refresh once ${holding === 1 ? 'it finishes' : 'they finish'}.`;

const whyNoAnswer = (res: GitRunResult): string =>
  res.noExit ?? (res.code === GIT_TIMED_OUT ? 'timed out' : `git exited ${res.code}`);

/** What a gitfile starts with, byte for byte. */
const GITFILE_PREFIX = Buffer.from('gitdir: ');

/** Said when git answered with an exit status of its own and no structure proves the checkout dead:
 *  another Retry reads the same bytes and gets the same answer. */
const REPAIR_ADVICE =
  'Retry cannot help until the checkout is repaired. Removing the repository deletes this checkout, including any commit that was never pushed.';

/** A git work tree whose top level is `dest` itself and that has a commit to stand on.
 *  `unusable`: a different top level, HEAD exit 1, `dest` itself absent or not a directory when git
 *  gave no answer, or, after `--show-cdup` exited non-zero, a `.git` that strict no-follow reads
 *  prove is not what git requires: absent; a directory without HEAD, with a HEAD that is neither a
 *  `ref:` line nor an object id, or without objects/ or refs/ (unless a commondir names their
 *  home); a file that does not start with `gitdir: `; or a file naming a gitdir inside `dest` that
 *  is absent.
 *  `unknown`: git gave no answer while `dest` is a directory, or exited non-zero over a `.git` those
 *  reads cannot prove dead (a corrupt config, unreadable, linked or external metadata), or a HEAD
 *  read other than exit 0 or 1. `repairNeeded` marks the ones where git answered with an exit
 *  status of its own.
 *  Unknown must never trigger a rebuild: it moves the folder. */
export async function usableCheckout(
  dest: string,
): Promise<'usable' | 'unusable' | { unknown: string; repairNeeded?: true }> {
  const cdup = await gitRun(dest, ['rev-parse', '--show-cdup']);
  if (gitGaveNoAnswer(cdup)) {
    try {
      const there = await lstatNoFollow(path.dirname(dest), path.basename(dest), { strict: true });
      return there?.kind === 'directory' ? { unknown: whyNoAnswer(cdup) } : 'unusable';
    } catch (err) {
      logger.warn({ err, dest }, 'checkout directory unreadable after git gave no answer');
      return { unknown: whyNoAnswer(cdup) };
    }
  }
  if (cdup.code !== 0) {
    // Exit codes cannot distinguish corrupt config from a dead .git. Rebuild only when strict
    // no-follow reads prove that what git requires is missing or cannot be what it requires;
    // everything else stays unknown.
    try {
      const entry = await lstatNoFollow(dest, '.git', { strict: true });
      if (entry === null) return 'unusable';
      if (entry.kind === 'directory') {
        // git takes a HEAD that starts with `ref:` or with an object id; the first 40 bytes tell.
        const head = await readFileNoFollow(dest, '.git/HEAD', { strict: true, maxBytes: 40 });
        if (head === null) return 'unusable';
        const start = head.data.toString('latin1');
        if (!start.startsWith('ref:') && !/^[0-9a-f]{40}/i.test(start)) return 'unusable';
        // A commondir file moves objects/ and refs/ to the directory it names.
        if ((await lstatNoFollow(dest, '.git/commondir', { strict: true })) === null) {
          for (const part of ['objects', 'refs']) {
            if ((await lstatNoFollow(dest, `.git/${part}`, { strict: true })) === null) {
              return 'unusable';
            }
          }
        }
      } else if (entry.kind === 'file') {
        const read = await readFileNoFollow(dest, '.git', { strict: true, maxBytes: 4096 });
        if (read && !read.data.subarray(0, GITFILE_PREFIX.length).equals(GITFILE_PREFIX)) {
          return 'unusable';
        }
        const gitfile = read?.data.toString('utf8');
        if (
          read &&
          !read.truncated &&
          gitfile !== undefined &&
          Buffer.from(gitfile).equals(read.data)
        ) {
          // Git removes trailing CR/LF from a gitfile; spaces belong to the directory name.
          const gitdir = gitfile.slice(GITFILE_PREFIX.length).replace(/[\r\n]+$/, '');
          // Git opens ".." through the file system, behind any link on the way; path.resolve
          // collapses it by its text. A gitdir with one cannot be judged absent from its text.
          if (!gitdir.split('/').includes('..')) {
            const rel = path.relative(dest, path.resolve(dest, gitdir));
            if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
              if ((await lstatNoFollow(dest, rel, { strict: true })) === null) return 'unusable';
            }
          }
        }
      }
    } catch (err) {
      // An unreadable entry cannot prove that rebuilding is safe.
      logger.warn(
        { err, dest },
        'checkout structure unreadable after git failed; leaving it unknown',
      );
    }
    // Git's own words tell a corrupt config from an ownership refusal. For the reader of the log
    // only: nothing branches on them.
    logger.warn(
      { dest, stderr: cdup.stderr.trim().slice(0, 500) },
      'git exited non-zero over a checkout nothing proves dead; leaving it unknown',
    );
    return { unknown: whyNoAnswer(cdup), repairNeeded: true };
  }
  if (cdup.stdout.trim() !== '') return 'unusable';
  const head = await gitRun(dest, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code === 0) return 'usable';
  if (head.code === 1) return 'unusable';
  if (gitGaveNoAnswer(head)) return { unknown: whyNoAnswer(head) };
  // For the reader of the log only: nothing branches on git's words.
  logger.warn(
    { dest, stderr: head.stderr.trim().slice(0, 500) },
    'git exited other than 0 or 1 reading HEAD; leaving the checkout unknown',
  );
  return { unknown: whyNoAnswer(head), repairNeeded: true };
}

interface RefreshSource {
  label: string;
  /** Fetches `branch` into FETCH_HEAD; answers git's first error line, or null. */
  fetch(branch: string, extra: string[]): Promise<string | null>;
}

async function sourceFor(
  db: Database,
  payload: RepoJobPayload,
  dest: string,
): Promise<RefreshSource | null> {
  if (payload.source === 'local_path') {
    const folder = payload.localPath;
    if (!folder) return null;
    return {
      label: 'the folder it was imported from',
      fetch: async (branch, extra) => {
        const res = await gitRun(
          dest,
          ['fetch', ...extra, '--', folder, `refs/heads/${branch}`],
          undefined,
          { allowFileTransport: true },
        );
        return res.code === 0 ? null : firstLine(res.stderr || res.stdout);
      },
    };
  }
  if (!(await detectOrigin(dest))) return null;
  return {
    label: 'its remote',
    fetch: async (branch, extra) => {
      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
      const argv: string[] = [];
      let secret: string | null = null;
      if (payload.credentialsId) {
        try {
          const helper = await buildCredentialHelper(
            db,
            payload.credentialsId,
            payload.userId,
            payload.remoteUrl,
          );
          secret = helper.secret;
          Object.assign(env, helper.env);
          argv.push(...helper.argv);
        } catch (err) {
          return `the stored credential could not be read (${err instanceof Error ? err.message : String(err)})`;
        }
      }
      try {
        const res = await originGitRun(
          dest,
          [...argv, 'fetch', ...extra, '--end-of-options', 'origin', `refs/heads/${branch}`],
          env,
        );
        return res.code === 0 ? null : scrubSecret(firstLine(res.stderr || res.stdout), secret);
      } catch (err) {
        return firstLine(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Only pre-move gates may answer this refusal, after their captured files are put back. */
function unreadableOperationRefusal(err: unknown): string {
  if (!(err instanceof GitOperationUnreadableError)) throw err;
  return `Not refreshed: the checkout could not be checked for an open merge or rebase (${firstLine(err.message)}). The checkout was not moved.`;
}

/** Fast-forward the checkout to its source. Answers why it was left as it was, or null once it is
 *  up to date. `merge --ff-only` never drops a commit or overwrites a local change: git refuses. */
export async function fastForward(
  db: Database,
  payload: RepoJobPayload,
  dest: string,
): Promise<string | null> {
  const head = await gitRun(dest, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code === 1) return 'Not refreshed: the checkout is not on a branch.';
  if (head.code !== 0)
    return `Not refreshed: could not read the checkout's branch (${firstLine(head.stderr || head.stdout)}).`;
  const branch = head.stdout.trim();
  let source: RefreshSource | null;
  try {
    source = await sourceFor(db, payload, dest);
  } catch (err) {
    return `Not refreshed: could not read the remote (${firstLine(err instanceof Error ? err.message : String(err))}).`;
  }
  if (!source) return 'Nothing to refresh from: this repository has no remote.';

  const fetchError = await source.fetch(branch, []);
  if (fetchError)
    return `Not refreshed: could not fetch ${branch} from ${source.label} (${fetchError}).`;
  const fetchedHead = await gitRun(dest, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  if (fetchedHead.code !== 0)
    return `Not refreshed: could not read the fetched commit (${firstLine(fetchedHead.stderr || fetchedHead.stdout)}).`;
  const target = fetchedHead.stdout.trim();
  if (!target) return `Not refreshed: could not read the fetched commit (empty answer).`;

  let base = await gitRun(dest, ['merge-base', 'HEAD', target]);
  if (base.code === 1) {
    const shallow = await gitRun(dest, ['rev-parse', '--is-shallow-repository']);
    if (shallow.code !== 0 || !['true', 'false'].includes(shallow.stdout.trim())) {
      return `Not refreshed: could not read whether the checkout is shallow (${firstLine(shallow.stderr || shallow.stdout)}).`;
    }
    if (shallow.stdout.trim() === 'true') {
      const deepenError = await source.fetch(branch, ['--deepen=50']);
      if (deepenError)
        return `Not refreshed: could not deepen ${branch} from ${source.label} (${deepenError}).`;
      base = await gitRun(dest, ['merge-base', 'HEAD', target]);
    }
  }
  if (base.code === 1) {
    return `Not refreshed: this checkout and ${source.label} have no history in common.`;
  }
  if (base.code !== 0)
    return `Not refreshed: could not read the merge base (${firstLine(base.stderr || base.stdout)}).`;

  const counts = await gitRun(dest, ['rev-list', '--left-right', '--count', `HEAD...${target}`]);
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (counts.code !== 0 || !Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return `Not refreshed: the checkout could not be compared with ${source.label}.`;
  }
  if (ahead! > 0) {
    const theirs =
      behind! > 0 ? `, and ${source.label} has ${plural(behind!, 'commit')} it does not` : '';
    return `Not refreshed: this checkout has ${plural(ahead!, 'commit')} that ${source.label} does not${theirs}. Nothing was changed.`;
  }
  if (behind === 0) return null;

  const fence = (conn: Parameters<typeof checkoutHoldingTasks>[0]) =>
    checkoutHoldingTasks(conn, payload.repositoryId);
  // Under both projection locks, and only while no task holds the checkout: an upgrade that is
  // still writing its record takes the project-state lock, and refuses once its task is no longer
  // holding. The check runs again here so no sweep can rewrite a file between it and the move; a
  // file it finds rewritten ends the transaction unmoved and goes back to the set-aside.
  let asided = false;
  const kept: KeptFiles = new Map();
  const headRead = await gitRun(dest, ['rev-parse', 'HEAD']);
  if (headRead.code !== 0) {
    return `Not refreshed: the checkout's HEAD could not be read (${firstLine(headRead.stderr || headRead.stdout)}).`;
  }
  const before = headRead.stdout.trim();
  for (let attempt = 1; ; attempt++) {
    let aside;
    try {
      aside = await setAsideHaiveProjections(db, payload.repositoryId, dest, fence);
    } catch (err) {
      try {
        if (asided) await putBackAfterFailure(db, payload.repositoryId, dest, kept, err);
      } catch (recovered) {
        return unreadableOperationRefusal(recovered);
      }
      return unreadableOperationRefusal(err);
    }
    if ((aside.outcome === 'refused' || aside.outcome === 'held') && asided) {
      await putBackProjections(db, payload.repositoryId, dest, kept);
    }
    if (aside.outcome === 'refused') {
      return `Not refreshed: ${aside.reason}. The checkout was not moved.`;
    }
    if (aside.outcome === 'held') return holdingRefusal(aside.holding);
    if (aside.outcome === 'set-aside') {
      asided = true;
      for (const [file, was] of aside.kept) if (!kept.has(file)) kept.set(file, was);
    }

    let moved;
    try {
      moved = await db.transaction(async (tx) => {
        // Every task's start and every revival take this lock, so none lands between the fence and the move.
        await lockRepositoryTasksKey(tx, payload.repositoryId);
        let check;
        try {
          check = await restoreProjectionsInTx(tx, payload.repositoryId, dest);
        } catch (err) {
          if (err instanceof GitOperationUnreadableError) return { gateError: err };
          throw err;
        }
        if (check.outcome !== 'clean') return { again: check, merge: null, after: null };
        if ((await checkoutHoldingTasks(tx, payload.repositoryId)) > 0) {
          return { again: check, merge: null, after: null };
        }
        const merge = await gitRun(dest, ['merge', '--ff-only', target]);
        // A failed process may still have moved HEAD; only this read decides recovery.
        return { again: check, merge, after: await headCommit(dest) };
      });
    } catch (err) {
      if (asided) await recoverAfterMoveFailure(db, payload.repositoryId, dest, kept, before, err);
      throw err;
    }
    if ('gateError' in moved) {
      try {
        if (asided)
          await putBackAfterFailure(db, payload.repositoryId, dest, kept, moved.gateError);
      } catch (recovered) {
        return unreadableOperationRefusal(recovered);
      }
      return unreadableOperationRefusal(moved.gateError);
    }
    const { again, merge: merged, after } = moved;
    if (again.outcome === 'retry' && attempt < MOVE_ATTEMPTS) continue;
    if (after !== null && after !== before) {
      let handBackFailed = false;
      try {
        await handBackAfterMove(dest, before);
      } catch (err) {
        handBackFailed = true;
        throw err;
      } finally {
        try {
          await resyncHaiveProjections(db, payload.repositoryId, dest);
        } catch (err) {
          if (!handBackFailed) throw err;
          logger.warn(
            { err, repositoryId: payload.repositoryId },
            'projection resync failed after hand-back failure',
          );
        } finally {
          await restoreKeptMetadata(dest, kept);
        }
      }
    } else if (asided) await putBackProjections(db, payload.repositoryId, dest, kept);
    if (again.outcome === 'refused') {
      return `Not refreshed: ${again.reason}. The checkout was not moved.`;
    }
    if (again.outcome === 'retry') {
      return "Not refreshed: Haive's project files kept changing under the move. The checkout was not moved; refresh again.";
    }
    if (merged === null) return 'Not refreshed: a task started using this repository meanwhile.';
    if (merged.code !== 0) {
      return after === before
        ? `Not refreshed: git refused the fast-forward (${firstLine(merged.stderr || merged.stdout)}).`
        : `Refresh failed: the fast-forward moved the checkout but failed (${firstLine(merged.stderr || merged.stdout)}).`;
    }
    break;
  }
  logger.info(
    { repositoryId: payload.repositoryId, branch, commits: behind },
    'repository fast-forwarded to its source',
  );
  return null;
}

/** Move what stands at `rel` out of the way, keeping it. An empty directory holds nothing to keep. */
async function moveAside(anchor: string, rel: string): Promise<string | null> {
  const info = await lstatNoFollow(anchor, rel, { strict: true });
  if (!info) return null;
  if (info.kind === 'directory' && ((await readdirNoFollow(anchor, rel)) ?? []).length === 0) {
    await removeNoFollow(anchor, rel);
    return null;
  }
  const asideRel = `${rel}.aside-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await renameNoFollow(anchor, rel, asideRel, { noReplace: true });
  return path.join(anchor, asideRel);
}

/** How a rebuild ends once the old folder has been moved aside. BullMQ runs a job that throws again,
 *  `attempts` times, and each run would find what this one left at the checkout and move that
 *  aside once more; an unrecoverable error ends the job, and a person's Retry starts a new one. */
function failedAfterMove(
  problem: string,
  aside: string | null,
  cause?: unknown,
): UnrecoverableError {
  const err = new UnrecoverableError(
    `Not refreshed: ${aside ? `the previous folder was kept next to the checkout as ${path.basename(aside)}, but ` : ''}${problem}.`,
  );
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** A repository whose checkout is not usable: clone or copy it again, the old folder kept. */
async function rebuild(
  db: Database,
  payload: RepoJobPayload,
  repoStorageRoot: string,
  rel: string,
  dest: string,
): Promise<void> {
  const fromFolder = payload.source === 'local_path' ? payload.localPath : undefined;
  const fromRemote = payload.source === 'local_path' ? undefined : payload.remoteUrl;
  if (!fromFolder && !fromRemote) {
    throw new Error('Nothing to refresh from: this repository has no remote.');
  }
  if (fromRemote) assertCloneUrl(fromRemote, 'refresh');
  // Everything the new tree comes from is proved before the old one is moved: a failure here
  // leaves the checkout where it was.
  if (fromFolder && !(await lstatNoFollow(fromFolder, '', { strict: true }))) {
    throw new Error(
      `Not refreshed: the folder this repository was imported from (${fromFolder}) is gone. Nothing was moved.`,
    );
  }
  // A folder whose own .git is dead copies to a tree that is dead too, and the next refresh
  // would move that aside once more: one full-size folder per refresh, for good.
  if (fromFolder) {
    const source = await usableCheckout(fromFolder);
    if (source === 'unusable') {
      throw new Error(
        `Not refreshed: the folder this repository was imported from (${fromFolder}) is not a usable git checkout. Nothing was moved.`,
      );
    }
    if (source !== 'usable') {
      throw new Error(
        `Not refreshed: the folder this repository was imported from (${fromFolder}) could not be examined (${source.unknown}). Nothing was moved.` +
          (source.repairNeeded ? ' Retry cannot help until that folder is repaired.' : ''),
      );
    }
  }
  const auth =
    fromRemote && payload.credentialsId
      ? await buildCredentialHelper(db, payload.credentialsId, payload.userId, payload.remoteUrl)
      : undefined;
  const aside = await moveAside(repoStorageRoot, rel);
  // Publish a folder copy only after it finishes. A failed or interrupted copy must never
  // leave a partial checkout that the next refresh could mistake for ready.
  const stagingRel = fromFolder ? `${rel}.rebuild-${randomUUID()}` : null;
  try {
    if (fromFolder) {
      await ensureDirNoFollow(repoStorageRoot, stagingRel!);
      await copyTree(fromFolder, path.join(repoStorageRoot, stagingRel!));
      await renameNoFollow(repoStorageRoot, stagingRel!, rel, { noReplace: true });
    } else {
      await ensureDirNoFollow(repoStorageRoot, payload.userId);
      await gitClone(fromRemote!, dest, payload.branch, auth);
    }
  } catch (err) {
    if (stagingRel) {
      try {
        await removeNoFollow(repoStorageRoot, stagingRel, { recursive: true });
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, stagingRel },
          'unfinished refresh copy could not be removed',
        );
        throw failedAfterMove(
          `the new checkout could not be built (${(err instanceof Error ? err.message : String(err)).trim()}); the unfinished copy was kept next to the checkout as ${path.basename(stagingRel)} because cleanup failed (${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`,
          aside,
          err,
        );
      }
    }
    throw failedAfterMove(
      `the new checkout could not be built (${(err instanceof Error ? err.message : String(err)).trim()})`,
      aside,
      err,
    );
  }
  const built = await usableCheckout(dest);
  if (built !== 'usable') {
    throw failedAfterMove(
      built === 'unusable'
        ? 'the rebuilt checkout is not usable'
        : `the rebuilt checkout could not be examined (${built.unknown})`,
      aside,
    );
  }
  await persistDetection(
    db,
    payload.repositoryId,
    dest,
    aside
      ? `The previous folder was not a usable checkout; it was kept next to the checkout as ${path.basename(aside)}.`
      : null,
  );
}

/** Bring a repository's checkout up to its source without deleting anything. */
export async function handleRefresh(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  const rel = `${payload.userId}/${payload.repositoryId}`;
  const dest = path.join(repoStorageRoot, rel);
  return withRootClaim(
    db,
    payload.repositoryId,
    async () => {
      const state = await usableCheckout(dest);
      if (typeof state === 'object') {
        // The queue starts at cloning. Throw so its catch records error and offers Retry;
        // detection would import a mirror from a checkout we could not examine.
        throw new Error(
          `Not refreshed: the checkout could not be examined (${state.unknown}). Nothing was moved.` +
            (state.repairNeeded ? ` ${REPAIR_ADVICE}` : ''),
        );
      }
      const usable = state === 'usable';
      const holding = await checkoutHoldingTasks(db, payload.repositoryId);
      if (holding > 0) {
        const refusal = holdingRefusal(holding);
        if (!usable) throw new Error(refusal);
        await persistDetection(db, payload.repositoryId, dest, refusal);
        return;
      }
      // A row stamped before 0196 takes its base from the checkout before a fast-forward moves it,
      // so a failed seed leaves the checkout where it is. A rebuild keeps the old tree aside.
      const seeded = seedPlanBaseFromCheckout(db, payload.repositoryId, dest);
      if (usable) await seeded;
      else
        await seeded.catch((err: unknown) =>
          logger.warn(
            { err, repositoryId: payload.repositoryId },
            'plan base not seeded before rebuild',
          ),
        );
      if (!usable) {
        await rebuild(db, payload, repoStorageRoot, rel, dest);
        return;
      }
      await persistDetection(db, payload.repositoryId, dest, await fastForward(db, payload, dest));
    },
    'refresh',
  );
}
