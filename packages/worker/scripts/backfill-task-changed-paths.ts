/**
 * One-off, idempotent maintenance script (task-time estimation v2.7).
 *
 * Populates tasks.changed_paths + tasks.commit_sha for PRE-v1 completed workflow tasks —
 * rows that finished before 10-gate-3-commit started persisting the commit outcome, so the
 * effort estimator (00b-estimate / 06b file-overlap refinement) can anchor on the files
 * those historical tasks touched. New tasks record this live; this backfills the old ones
 * where the commit is still reachable.
 *
 * How a task's change set is recovered:
 *  - The task's work lives on its durable worktree_branch ref, which survives worktree-dir
 *    teardown (the branch is separate from the checked-out tree).
 *  - `git diff --name-only <base>...<worktree_branch>` (three-dot) is the branch's OWN
 *    changes vs its fork point (merge-base is computed internally), where <base> is the
 *    repo's default branch (repositories.branch, default main). If the base ref is gone we
 *    fall back to the tip commit's files (`git show --name-only <branch>`).
 *  - commit_sha = the branch tip. Paths are capped at MAX_PERSISTED_CHANGED_PATHS, matching
 *    the live persistCommitOutcome.
 *
 * Scope: completed workflow tasks with changed_paths IS NULL and a worktree_branch, whose
 * repository is resolvable on this worker's disk (the haive_repos volume, or a storage_path
 * that is a git work tree). Tasks whose branch or repo is gone are left untouched (skipped),
 * so the estimator simply falls back to description-only anchoring for them.
 *
 * Idempotent: only rows with changed_paths IS NULL are selected, and a successful backfill
 * makes them non-null, so re-running selects/writes nothing new. A task we can't resolve
 * stays NULL and is retried harmlessly on the next run (no write).
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted id to backfill-task-changed-paths-backup.json,
 *    then updates inside a single transaction.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && pnpm exec tsx scripts/backfill-task-changed-paths.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 pnpm exec tsx scripts/backfill-task-changed-paths.ts' # apply
 *
 * Rollback: UPDATE tasks SET changed_paths=NULL, commit_sha=NULL WHERE id IN (<backed-up ids>).
 * (Every targeted row had both NULL before this ran, so nulling them again is exact.)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';

const exec = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-task-changed-paths-backup.json';
const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
/** Same cap the live persistCommitOutcome applies to changed_paths. */
const MAX_PERSISTED_CHANGED_PATHS = 200;

const db = createDatabase(DATABASE_URL);

async function gitRun(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: stdout.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: (e.stdout ?? '').toString(), code: typeof e.code === 'number' ? e.code : 1 };
  }
}

/** First candidate path that is a git work tree: the repo's own storage_path, else the
 *  haive_repos volume subpath (<root>/<userId>/<repoId>). null when neither resolves. */
async function resolveRepoDir(
  storagePath: string | null,
  userId: string,
  repositoryId: string,
): Promise<string | null> {
  const candidates = [storagePath, join(REPO_STORAGE_ROOT, userId, repositoryId)].filter(
    (p): p is string => !!p,
  );
  for (const dir of candidates) {
    const check = await gitRun(dir, ['rev-parse', '--is-inside-work-tree']);
    if (check.code === 0 && check.stdout.trim() === 'true') return dir;
  }
  return null;
}

interface PlannedUpdate {
  taskId: string;
  title: string;
  repoDir: string;
  branch: string;
  commitSha: string;
  changedPaths: string[];
  source: 'diff' | 'tip';
}

/** Recover a task's change set + tip sha from its branch, or null when unrecoverable. */
async function planForTask(
  repoDir: string,
  branch: string,
  baseBranch: string,
): Promise<{ commitSha: string; changedPaths: string[]; source: 'diff' | 'tip' } | null> {
  // Branch tip must exist to anchor anything.
  const tip = await gitRun(repoDir, ['rev-parse', '--verify', `${branch}^{commit}`]);
  if (tip.code !== 0) return null;
  const commitSha = tip.stdout.trim();
  if (!commitSha) return null;

  // Preferred: the branch's own changes vs its fork point (three-dot handles merge-base).
  let source: 'diff' | 'tip' = 'diff';
  let raw = await gitRun(repoDir, ['diff', '--name-only', `${baseBranch}...${branch}`]);
  if (raw.code !== 0) {
    // Base ref gone/unknown — fall back to just the tip commit's files.
    source = 'tip';
    raw = await gitRun(repoDir, ['show', '--name-only', '--format=', branch]);
    if (raw.code !== 0) return null;
  }
  const changedPaths = Array.from(
    new Set(
      raw.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ).slice(0, MAX_PERSISTED_CHANGED_PATHS);
  return { commitSha, changedPaths, source };
}

async function main(): Promise<void> {
  const tasks = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.type, 'workflow'),
      eq(schema.tasks.status, 'completed'),
      isNull(schema.tasks.changedPaths),
      isNotNull(schema.tasks.worktreeBranch),
    ),
    columns: { id: true, title: true, userId: true, repositoryId: true, worktreeBranch: true },
  });
  console.log(`Candidates (completed workflow, changed_paths NULL, has branch): ${tasks.length}`);

  const plans: PlannedUpdate[] = [];
  let skippedNoRepo = 0;
  let skippedUnrecoverable = 0;

  for (const t of tasks) {
    if (!t.repositoryId || !t.worktreeBranch) {
      skippedNoRepo += 1;
      continue;
    }
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, t.repositoryId),
      columns: { storagePath: true, branch: true },
    });
    const repoDir = repo
      ? await resolveRepoDir(repo.storagePath ?? null, t.userId, t.repositoryId)
      : null;
    if (!repoDir) {
      skippedNoRepo += 1;
      continue;
    }
    const recovered = await planForTask(repoDir, t.worktreeBranch, repo?.branch ?? 'main');
    if (!recovered) {
      skippedUnrecoverable += 1;
      continue;
    }
    plans.push({
      taskId: t.id,
      title: t.title,
      repoDir,
      branch: t.worktreeBranch,
      ...recovered,
    });
  }

  console.log(
    `\nRecoverable: ${plans.length} · skipped (repo/branch gone): ${skippedNoRepo} · ` +
      `skipped (unrecoverable): ${skippedUnrecoverable}`,
  );
  for (const p of plans) {
    console.log(
      `  [${p.taskId}] "${p.title}" — ${p.changedPaths.length} path(s) via ${p.source}, ` +
        `sha ${p.commitSha.slice(0, 10)}`,
    );
  }

  if (!plans.length) {
    console.log('\nNothing to backfill (already clean or nothing recoverable).');
    process.exit(0);
  }
  if (!APPLY) {
    console.log(`\nDRY RUN — ${plans.length} task(s) would be backfilled. Set APPLY=1 to write.`);
    process.exit(0);
  }

  writeFileSync(
    BACKUP_PATH,
    JSON.stringify(
      plans.map((p) => p.taskId),
      null,
      2,
    ),
  );
  console.log(`\nWrote backup of ${plans.length} id(s) to ${BACKUP_PATH}`);

  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx
        .update(schema.tasks)
        .set({ commitSha: p.commitSha, changedPaths: p.changedPaths, updatedAt: new Date() })
        .where(eq(schema.tasks.id, p.taskId));
    }
  });
  console.log(`Applied ${plans.length} backfill(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
