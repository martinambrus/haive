import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';
import { schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger, type RepoJobPayload } from '@haive/shared';
import { copyTree, gitClone, persistDetection, withRootClaim } from './clone.js';
import { buildCredentialHelper, detectOrigin, gitRun, scrubSecret } from './git-push.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Tasks holding this repository's checkout right now. */
export async function checkoutHoldingTasks(db: Database, repositoryId: string): Promise<number> {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
    ),
    columns: { id: true },
  });
  return rows.length;
}

/** A git work tree whose top level is `dest` itself and that has a commit to stand on. */
async function usableCheckout(dest: string): Promise<boolean> {
  const cdup = await gitRun(dest, ['rev-parse', '--show-cdup']);
  if (cdup.code !== 0 || cdup.stdout.trim() !== '') return false;
  return (await gitRun(dest, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
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
        const res = await gitRun(dest, ['fetch', ...extra, '--', folder, `refs/heads/${branch}`]);
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
          const helper = await buildCredentialHelper(db, payload.credentialsId, payload.userId);
          secret = helper.secret;
          Object.assign(env, helper.env);
          argv.push(...helper.argv);
        } catch (err) {
          return `the stored credential could not be read (${err instanceof Error ? err.message : String(err)})`;
        }
      }
      const res = await gitRun(dest, [...argv, 'fetch', ...extra, 'origin', branch], env);
      return res.code === 0 ? null : scrubSecret(firstLine(res.stderr || res.stdout), secret);
    },
  };
}

/** Fast-forward the checkout to its source. Answers why it was left as it was, or null once it is
 *  up to date. `merge --ff-only` never drops a commit or overwrites a local change: git refuses. */
async function fastForward(
  db: Database,
  payload: RepoJobPayload,
  dest: string,
): Promise<string | null> {
  const head = await gitRun(dest, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code !== 0) return 'Not refreshed: the checkout is not on a branch.';
  const branch = head.stdout.trim();
  const source = await sourceFor(db, payload, dest);
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

  const merged = await gitRun(dest, ['merge', '--ff-only', target]);
  if (merged.code !== 0) {
    return `Not refreshed: git refused the fast-forward (${firstLine(merged.stderr || merged.stdout)}).`;
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
  const aside = await moveAside(repoStorageRoot, rel);
  if (fromFolder) {
    await ensureDirNoFollow(repoStorageRoot, rel);
    await copyTree(fromFolder, dest);
  } else {
    await ensureDirNoFollow(repoStorageRoot, payload.userId);
    const auth = payload.credentialsId
      ? await buildCredentialHelper(db, payload.credentialsId, payload.userId)
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
      const usable = await usableCheckout(dest);
      const holding = await checkoutHoldingTasks(db, payload.repositoryId);
      if (holding > 0) {
        const refusal = `Not refreshed: ${plural(holding, 'task')} ${holding === 1 ? 'is' : 'are'} using this repository. Refresh once ${holding === 1 ? 'it finishes' : 'they finish'}.`;
        if (!usable) throw new Error(refusal);
        await persistDetection(db, payload.repositoryId, dest, refusal);
        return;
      }
      if (!usable) {
        await rebuild(db, payload, repoStorageRoot, rel, dest);
        return;
      }
      await persistDetection(db, payload.repositoryId, dest, await fastForward(db, payload, dest));
    },
    'refresh',
  );
}
