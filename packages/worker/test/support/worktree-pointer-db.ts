import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '@haive/database';

export const POINTER_USER = 'u1';
export const POINTER_REPO = 'r1';
export const POINTER_BRANCH = 'feature/x';
export const POINTER_DIR = 'feature-x';

export interface PointerStepRow {
  stepId?: string;
  status: string;
  round?: number;
  output: unknown;
}

export interface PointerTaskRow {
  userId?: string;
  repositoryId?: string | null;
  worktreeBranch: string | null;
  worktreePath?: string | null;
  type?: string;
  metadata?: Record<string, unknown> | null;
}

/** The throwaway storage root named by REPO_STORAGE_ROOT, laid out as `<root>/<user>/<repo>`: the
 *  worker's repo volume and the repository's storage path at once. A test sets the variable to a
 *  unique path in vi.hoisted, BEFORE the module under test is imported, because that module reads
 *  it into a constant at load. */
export interface PointerFixture {
  root: string;
  repoRoot: string;
  /** Absolute path of the feature worktree directory, created on disk only by `mkWorktree`. */
  worktreePath: string;
  mkWorktree(dirName?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makePointerFixture(): Promise<PointerFixture> {
  const root = process.env.REPO_STORAGE_ROOT;
  if (!root) throw new Error('REPO_STORAGE_ROOT must be set in vi.hoisted before the imports');
  const repoRoot = path.join(root, POINTER_USER, POINTER_REPO);
  await mkdir(repoRoot, { recursive: true });
  return {
    root,
    repoRoot,
    worktreePath: path.join(repoRoot, '.haive', 'worktrees', POINTER_DIR),
    async mkWorktree(dirName = POINTER_DIR) {
      const dir = path.join(repoRoot, '.haive', 'worktrees', dirName);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Chainable, awaitable query stand-in: every builder method returns itself and awaiting it
 *  yields `rows`, so the stub answers whichever shape the code under test uses to read the
 *  01-worktree-setup rows (`select().from().where().orderBy().limit()`, with or without the
 *  tail). */
function chain(rows: unknown[]): unknown {
  const self: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => self;
    },
    apply: () => self,
  });
  return self;
}

/** A db stub holding the task row, the repository row and the task's `01-worktree-setup` rows
 *  (newest round last). Reads through `db.query.taskSteps` and through `db.select()` both see them. */
export function pointerDb(args: {
  task: PointerTaskRow | null;
  repo: { source?: string; storagePath?: string | null; localPath?: string | null } | null;
  steps?: PointerStepRow[];
}): Database {
  const rows = (args.steps ?? [])
    .map((s) => ({ stepId: '01-worktree-setup', round: 0, ...s }))
    .sort((a, b) => b.round - a.round);
  const task = args.task
    ? { userId: POINTER_USER, repositoryId: POINTER_REPO, worktreePath: null, ...args.task }
    : undefined;
  return {
    query: {
      tasks: { findFirst: async () => task },
      repositories: { findFirst: async () => args.repo ?? undefined },
      taskSteps: {
        findFirst: async () => rows[0],
        findMany: async () => rows,
      },
    },
    select: () => chain(rows),
  } as unknown as Database;
}
