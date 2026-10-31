import path from 'node:path';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  readdirNoFollow,
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
import { seedPlanBaseFromCheckout } from '../plan/mirror.js';
import { handBackAfterMove } from '../step-engine/git-merge.js';
import { gitWorkspaceStatus } from './git-workspace.js';
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

/** A git work tree whose top level is `dest` itself and that has a commit to stand on. A git run
 *  that gave no answer is `unknown`, which must not read as "not usable": a rebuild moves the folder. */
export async function usableCheckout(
  dest: string,
): Promise<'usable' | 'unusable' | { unknown: string }> {
  const cdup = await gitRun(dest, ['rev-parse', '--show-cdup']);
  if (gitGaveNoAnswer(cdup)) {
    const there = await lstatNoFollow(path.dirname(dest), path.basename(dest));
    return there?.kind === 'directory' ? { unknown: whyNoAnswer(cdup) } : 'unusable';
  }
  if (cdup.code !== 0) {
    return (await gitWorkspaceStatus(dest)) === 'absent'
      ? 'unusable'
      : { unknown: whyNoAnswer(cdup) };
  }
  if (cdup.stdout.trim() !== '') return 'unusable';
  const head = await gitRun(dest, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code === 0) return 'usable';
  return head.code === 1 ? 'unusable' : { unknown: whyNoAnswer(head) };
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

/** Fast-forward the checkout to its source. Answers why it was left as it was, or null once it is
 *  up to date. `merge --ff-only` never drops a commit or overwrites a local change: git refuses. */
export async function fastForward(
  db: Database,
  payload: RepoJobPayload,
  dest: string,
): Promise<string | null> {
  const head = await gitRun(dest, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code !== 0) return 'Not refreshed: the checkout is not on a branch.';
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
  const target = (
    await gitRun(dest, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
  ).stdout.trim();
  if (!target) return `Not refreshed: fetching ${branch} from ${source.label} brought no commit.`;

  let base = await gitRun(dest, ['merge-base', 'HEAD', target]);
  if (base.code !== 0) {
    const shallow = await gitRun(dest, ['rev-parse', '--is-shallow-repository']);
    if (shallow.stdout.trim() === 'true') {
      await source.fetch(branch, ['--deepen=50']);
      base = await gitRun(dest, ['merge-base', 'HEAD', target]);
    }
  }
  if (base.code !== 0) {
    return `Not refreshed: this checkout and ${source.label} have no history in common.`;
  }

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
      if (asided) await putBackAfterFailure(db, payload.repositoryId, dest, kept, err);
      throw err;
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
        const check = await restoreProjectionsInTx(tx, payload.repositoryId, dest);
        if (check.outcome !== 'clean') return { again: check, merge: null };
        if ((await checkoutHoldingTasks(tx, payload.repositoryId)) > 0) {
          return { again: check, merge: null };
        }
        return { again: check, merge: await gitRun(dest, ['merge', '--ff-only', target]) };
      });
    } catch (err) {
      if (asided) await recoverAfterMoveFailure(db, payload.repositoryId, dest, kept, before, err);
      throw err;
    }
    const { again, merge: merged } = moved;
    if (again.outcome === 'retry' && attempt < MOVE_ATTEMPTS) continue;
    if (merged?.code === 0) {
      await handBackAfterMove(dest, before);
      await resyncHaiveProjections(db, payload.repositoryId, dest);
      await restoreKeptMetadata(dest, kept);
    } else if (asided) await putBackProjections(db, payload.repositoryId, dest, kept);
    if (again.outcome === 'refused') {
      return `Not refreshed: ${again.reason}. The checkout was not moved.`;
    }
    if (again.outcome === 'retry') {
      return "Not refreshed: Haive's project files kept changing under the move. The checkout was not moved; refresh again.";
    }
    if (merged === null) return 'Not refreshed: a task started using this repository meanwhile.';
    if (merged.code !== 0) {
      return `Not refreshed: git refused the fast-forward (${firstLine(merged.stderr || merged.stdout)}).`;
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
  const info = await lstatNoFollow(anchor, rel);
  if (!info) return null;
  if (info.kind === 'directory' && ((await readdirNoFollow(anchor, rel)) ?? []).length === 0) {
    await removeNoFollow(anchor, rel);
    return null;
  }
  const asideRel = `${rel}.aside-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await renameNoFollow(anchor, rel, asideRel, { noReplace: true });
  return path.join(anchor, asideRel);
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
  const aside = await moveAside(repoStorageRoot, rel);
  if (fromFolder) {
    await ensureDirNoFollow(repoStorageRoot, rel);
    await copyTree(fromFolder, dest);
  } else {
    await ensureDirNoFollow(repoStorageRoot, payload.userId);
    const auth = payload.credentialsId
      ? await buildCredentialHelper(db, payload.credentialsId, payload.userId, payload.remoteUrl)
      : undefined;
    await gitClone(fromRemote!, dest, payload.branch, auth);
  }
  await persistDetection(
    db,
    payload.repositoryId,
    dest,
    aside ? `The previous folder was not a usable checkout; it was kept at ${aside}.` : null,
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
        await persistDetection(
          db,
          payload.repositoryId,
          dest,
          `Not refreshed: the checkout could not be examined (${state.unknown}). Nothing was moved.`,
        );
        return;
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
