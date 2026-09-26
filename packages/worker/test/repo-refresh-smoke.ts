/**
 * A refresh fast-forwards a checkout to its source and never deletes one, against a database and
 * real git repositories. One throwaway user and temp directory, deleted after.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger, type RepoJobPayload } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { handleClone, handleCopyLocal } from '../src/repo/clone.js';
import { handleRefresh } from '../src/repo/refresh.js';

const log = logger.child({ module: 'repo-refresh-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'gc.auto=0', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const hasCommit = (cwd: string, sha: string): boolean => {
  try {
    git(cwd, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
async function commitFile(repo: string, file: string, body: string, message: string) {
  await writeFile(path.join(repo, file), body);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const tmp = await mkdtemp(path.join(tmpdir(), 'repo-refresh-smoke-'));
  const storage = path.join(tmp, 'storage');
  await mkdir(storage);
  const userId = randomUUID();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'repo-refresh-smoke',
      emailBlindIndex: `repo-refresh-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
    const statusOf = async (id: string) =>
      (await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { status: true, statusMessage: true },
      }))!;

    // One bare remote and a seed clone that pushes to it.
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', `file://${origin}`, seed);
    await commitFile(seed, 'README.md', 'seed\n', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const push = async (file: string, body: string) => {
      const sha = await commitFile(seed, file, body, `update ${file}`);
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      return sha;
    };

    const cloned = async () => {
      const remoteUrl = `file://${origin}`;
      const [row] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'repo-refresh-smoke',
          source: 'git_https',
          remoteUrl,
          branch: 'main',
        })
        .returning({ id: schema.repositories.id });
      const payload: RepoJobPayload = {
        repositoryId: row!.id,
        userId,
        source: 'git_https',
        remoteUrl,
        branch: 'main',
      };
      await handleClone(payload, db, storage);
      return { payload, dest: path.join(storage, userId, row!.id) };
    };

    // 1. An unpushed commit is refused, not re-cloned away.
    {
      const { payload, dest } = await cloned();
      const local = await commitFile(dest, 'local.txt', 'unpushed\n', 'unpushed');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'an unpushed commit survives a refresh',
        hasCommit(dest, local) && git(dest, 'rev-parse', 'HEAD') === local,
      );
      check(
        'and the refusal says so beside a ready repository',
        row.status === 'ready' && /1 commit that its remote does not/.test(row.statusMessage ?? ''),
        row,
      );
    }

    // 2. A remote that moved ahead is fast-forwarded to; Haive's work beside it stays.
    {
      const { payload, dest } = await cloned();
      await mkdir(path.join(dest, '.haive', 'worktrees', 'task-x'), { recursive: true });
      await writeFile(path.join(dest, '.haive', 'worktrees', 'task-x', 'wip.txt'), 'wip\n');
      await writeFile(path.join(dest, 'README.md'), 'seed, edited by Haive\n');
      const upstream = await push('upstream.txt', 'from upstream\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'the checkout is fast-forwarded to its remote',
        git(dest, 'rev-parse', 'HEAD') === upstream,
      );
      check(
        'a task worktree and an uncommitted edit stay',
        (await readFile(path.join(dest, '.haive', 'worktrees', 'task-x', 'wip.txt'), 'utf8')) ===
          'wip\n' &&
          (await readFile(path.join(dest, 'README.md'), 'utf8')) === 'seed, edited by Haive\n',
      );
      check(
        'and the repository reads ready with nothing to report',
        row.status === 'ready' && row.statusMessage === null,
        row,
      );

      // 3. Up to date: nothing moves.
      await handleRefresh(payload, db, storage);
      check(
        'a refresh with nothing new changes nothing',
        git(dest, 'rev-parse', 'HEAD') === upstream,
      );
    }

    // 4. An incoming commit touching a file Haive changed: git refuses, the change stays.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await writeFile(path.join(dest, 'README.md'), 'Haive edit\n');
      await push('README.md', 'upstream edit\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a change the incoming commit would overwrite is kept and the head stays',
        (await readFile(path.join(dest, 'README.md'), 'utf8')) === 'Haive edit\n' &&
          git(dest, 'rev-parse', 'HEAD') === before,
      );
      check(
        'and git refusing is reported',
        /git refused the fast-forward/.test(row.statusMessage ?? ''),
        row,
      );
    }

    // 5. A task holding the checkout refuses the refresh.
    {
      const { payload, dest } = await cloned();
      const before = git(dest, 'rev-parse', 'HEAD');
      await push('while-running.txt', 'x\n');
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: payload.repositoryId,
          type: 'workflow',
          title: 'repo-refresh-smoke',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a task using the repository holds the refresh off',
        git(dest, 'rev-parse', 'HEAD') === before &&
          /1 task is using this repository/.test(row.statusMessage ?? ''),
        row,
      );
      await db.delete(schema.tasks).where(eq(schema.tasks.id, task!.id));
    }

    // 6. A writable folder import: fetched from the folder, Haive's own changes kept.
    {
      const folder = path.join(tmp, 'folder');
      git(tmp, 'init', '-q', '-b', 'main', folder);
      await commitFile(folder, 'app.txt', 'v1\n', 'v1');
      const [row] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'repo-refresh-smoke',
          source: 'local_path',
          localPath: folder,
          writable: true,
        })
        .returning({ id: schema.repositories.id });
      const payload: RepoJobPayload = {
        repositoryId: row!.id,
        userId,
        source: 'local_path',
        localPath: folder,
      };
      await handleCopyLocal(payload, db, storage);
      const dest = path.join(storage, userId, row!.id);
      await mkdir(path.join(dest, '.haive-data', 'knowledge_base'), { recursive: true });
      await writeFile(path.join(dest, '.haive-data', 'knowledge_base', 'kb.md'), 'kb\n');
      await writeFile(path.join(dest, 'app.txt'), 'v1, edited by Haive\n');
      const folderHead = await commitFile(folder, 'new.txt', 'from the folder\n', 'v2');
      await handleRefresh(payload, db, storage);
      check(
        'a folder import is fast-forwarded from the folder',
        git(dest, 'rev-parse', 'HEAD') === folderHead,
      );
      check(
        "and Haive's knowledge base and edit stay",
        (await readFile(path.join(dest, '.haive-data', 'knowledge_base', 'kb.md'), 'utf8')) ===
          'kb\n' &&
          (await readFile(path.join(dest, 'app.txt'), 'utf8')) === 'v1, edited by Haive\n',
      );
    }

    // 7. A folder that is not a usable checkout is moved aside, then cloned again.
    {
      const { payload, dest } = await cloned();
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest);
      await writeFile(path.join(dest, 'notes.txt'), 'keep me\n');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      const siblings = await readdir(path.join(storage, userId));
      const aside = siblings.find((n) => n.startsWith(`${payload.repositoryId}.aside-`));
      check(
        'an unusable folder is kept aside and the repository cloned again',
        !!aside &&
          (await readFile(path.join(storage, userId, aside, 'notes.txt'), 'utf8')) ===
            'keep me\n' &&
          git(dest, 'rev-parse', '--verify', 'HEAD').length === 40,
        { siblings },
      );
      check(
        'and the message says where it went',
        row.status === 'ready' && !!aside && (row.statusMessage ?? '').includes(aside),
        row,
      );
    }

    // 8. A detached HEAD is refused.
    {
      const { payload, dest } = await cloned();
      git(dest, 'checkout', '-q', '--detach');
      await handleRefresh(payload, db, storage);
      const row = await statusOf(payload.repositoryId);
      check(
        'a detached checkout is left as it is',
        /not on a branch/.test(row.statusMessage ?? ''),
        row,
      );
    }

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'REPO_REFRESH_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
      await rm(tmp, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
