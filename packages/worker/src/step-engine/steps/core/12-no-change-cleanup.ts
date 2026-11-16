import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@haive/database';
import {
  lstatNoFollow,
  openFileNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';
import { isBranchName } from '@haive/shared/git-args';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { assertOwnsStep, StepSupersededError, taskWriteTarget } from '../../step-ownership.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { gitRun } from '../../../repo/git-exec.js';
import { gitOperationMarker } from '../../../repo/git-operation.js';
import { isWorktreeLocked, worktreesHoldingBranch } from '../../../repo/git-workspace.js';
import { readUncommittedChanges } from '../../../repo/worktree-changes.js';
import { findWorktreePathClaimant } from '../../../repo/worktree-claims.js';
import { splitWorktreePath } from '../../../repo/worktree-paths.js';

const EVENT = 'worktree.no_change_cleanup';
const setupSchema = z.object({
  mode: z.literal('worktree'),
  worktreePath: z.string(),
  branchName: z.string().refine(isBranchName),
  baseBranch: z.string().refine(isBranchName),
});
type Setup = z.infer<typeof setupSchema>;
const journalSchema = setupSchema.extend({
  version: z.literal(1),
  id: z.uuid(),
  dev: z.string(),
  ino: z.string(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
type Journal = z.infer<typeof journalSchema>;

const refuse = (reason: string): never => {
  throw new Error(
    `No-change cleanup refused: ${reason}. Keep the worktree and branch; resolve the problem, then Retry.`,
  );
};
const command = async (dir: string, args: string[], reason: string) => {
  const result = await gitRun(dir, args);
  if (result.code !== 0) refuse(reason);
  return result.stdout.trim();
};
const stageRel = (journal: Journal) => `.haive/no-change-cleanup/${journal.id}`;
const sameIdentity = (
  info: NonNullable<Awaited<ReturnType<typeof lstatNoFollow>>>,
  journal: Journal,
) =>
  info.kind === 'directory' &&
  String(info.stats.dev) === journal.dev &&
  String(info.stats.ino) === journal.ino;

async function record(ctx: StepContext, journal: Journal): Promise<void> {
  ctx.throwIfCancelled();
  await ctx.db.transaction(async (tx) => {
    await assertOwnsStep(tx, ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(taskWriteTarget(ctx.taskId, ctx.epoch == null ? undefined : { epoch: ctx.epoch }))
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    await tx.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      eventType: EVENT,
      payload: journal,
    });
  });
}

/** An absent branch is a supported recovery cut, but a failed ref read is never absence. */
async function branchHead(repo: string, ref: string): Promise<string | null> {
  const exists = await gitRun(repo, ['show-ref', '--verify', '--quiet', ref]);
  if (exists.code === 1) return null;
  if (exists.code !== 0) refuse('could not read the branch');
  return command(
    repo,
    ['rev-parse', '--verify', `${ref}^{commit}`],
    'could not read the branch commit',
  );
}

async function removedBranchHead(ctx: StepContext, dir: string, tailBytes = 4096): Promise<string> {
  const log = await command(
    dir,
    ['rev-parse', '--git-path', 'logs/HEAD'],
    'could not locate the removed branch history',
  );
  const file = await openFileNoFollow(
    ctx.repoPath,
    relative(ctx.repoPath, resolve(dir, log)),
    'read',
    { strict: true },
  );
  if (!file) return refuse('could not read the removed branch history');
  try {
    // Only the final reflog entry is needed. A partial/oversized entry is unreadable,
    // never a license to fall back to some older, already-contained commit.
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, tailBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    const last = lines.at(-2);
    if (
      bytesRead !== buffer.length ||
      !text.endsWith('\n') ||
      (lines.length < 3 && size > buffer.length)
    )
      return refuse('could not read the removed branch history');
    const head = last?.match(/^[a-f0-9]{40,64} ([a-f0-9]{40,64}) /)?.[1];
    if (!head) return refuse('could not read the removed branch history');
    return head;
  } finally {
    await file.close();
  }
}

async function checkTree(
  ctx: StepContext,
  setup: Setup,
  head: string,
  branchAbsent: boolean,
): Promise<void> {
  const dir = setup.worktreePath;
  if (
    (await lstatNoFollow(ctx.repoPath, relative(ctx.repoPath, `${dir}/.git`), { strict: true }))
      ?.kind !== 'file'
  )
    refuse('the worktree gitfile is unreadable');
  const branch = await command(
    dir,
    ['symbolic-ref', '--quiet', 'HEAD'],
    'could not read the worktree branch',
  );
  if (branch !== `refs/heads/${setup.branchName}`) refuse('the worktree is on a different branch');
  const marker = await gitOperationMarker(dir, ctx.repoPath);
  // A multi-commit sequence can be between commits, without a *_HEAD pseudoref.
  const sequencer = await command(
    dir,
    ['rev-parse', '--git-path', 'sequencer'],
    'could not read Git operation state',
  );
  if (
    marker ||
    (await lstatNoFollow(ctx.repoPath, relative(ctx.repoPath, resolve(dir, sequencer)), {
      strict: true,
    }))
  )
    refuse(`a Git operation is open (${marker ?? 'sequencer'})`);
  const liveHead = await gitRun(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (liveHead.code === 0) {
    if (liveHead.stdout.trim() !== head) refuse('the worktree commit changed');
    const changes = await readUncommittedChanges(dir, 0);
    if (changes === null) return refuse('the worktree is unreadable');
    if (changes.count !== 0) refuse('the worktree holds uncommitted changes');
    return;
  }
  if (!branchAbsent || liveHead.code !== 1) return refuse('the worktree HEAD is unreadable');
  // If the branch was already deleted, status treats its index as an unborn branch.
  // Compare against the worktree's retained HEAD reflog instead, without recreating a ref.
  const flags = await command(
    dir,
    ['--no-optional-locks', 'ls-files', '-v', '-z'],
    'the worktree index is unreadable',
  );
  if (flags.split('\0').some((entry) => /^([a-z]|S) /.test(entry)))
    refuse('the worktree index is unreadable');
  const nested = await command(
    dir,
    ['--no-optional-locks', 'submodule', 'foreach', '--quiet', '--recursive', 'git ls-files -v -z'],
    'the submodule index is unreadable',
  );
  if (nested.split('\0').some((entry) => /^([a-z]|S) /.test(entry)))
    refuse('the submodule index is unreadable');
  const staged = await gitRun(dir, [
    '--no-optional-locks',
    'diff',
    '--cached',
    '--quiet',
    '--ignore-submodules=none',
    head,
    '--',
  ]);
  if (staged.code === 1) return refuse('the worktree holds uncommitted staged changes');
  if (staged.code !== 0) return refuse('the worktree index is unreadable');
  const diff = await gitRun(dir, [
    '--no-optional-locks',
    '-c',
    'core.fileMode=true',
    '-c',
    'core.trustctime=true',
    '-c',
    'core.checkStat=default',
    'diff',
    '--quiet',
    '--ignore-submodules=none',
    head,
    '--',
  ]);
  if (diff.code === 1) refuse('the worktree holds uncommitted changes');
  if (diff.code !== 0) refuse('the worktree is unreadable');
  if (
    await command(
      dir,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      'the worktree is unreadable',
    )
  )
    refuse('the worktree holds uncommitted changes');
}

/** Cancel is a discard action. Called only after the task's sandbox listing is empty;
 * failures keep cancellation unfinished so its ordinary redrive retries this removal. */
export async function discardNoChangeCleanupDirectories(
  db: Database,
  taskId: string,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { status: true, runListSnapshot: true },
  });
  if (task?.status !== 'cancelled' || !task.runListSnapshot?.includes('12-no-change-cleanup'))
    return;
  const events = await db.query.taskEvents.findMany({
    where: and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, EVENT)),
  });
  for (const event of events) {
    const saved = journalSchema.parse(event.payload);
    const split = splitWorktreePath(saved.worktreePath);
    if (!split) return refuse('the cleanup recovery path is invalid');
    const current = await lstatNoFollow(split.anchor, stageRel(saved), { strict: true });
    if (current && !sameIdentity(current, saved))
      return refuse('the cleanup recovery directory changed');
    await removeNoFollow(split.anchor, stageRel(saved), { recursive: true });
  }
}

/** Explicit-composition only: the built-in workflow still finishes through step 12. */
export const noChangeCleanupStep: StepDefinition<
  Setup,
  { removed: true; branchDeleted: true; message: string }
> = {
  metadata: {
    id: '12-no-change-cleanup',
    workflowType: 'core',
    index: 14,
    title: 'No-change worktree cleanup',
    description:
      'Removes a clean task worktree and its branch only when the base already contains every branch commit.',
    requiresCli: false,
  },
  async detect(ctx) {
    const previous = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '01-worktree-setup',
      ctx.round,
    );
    const parsed = setupSchema.safeParse(previous?.output);
    if (!parsed.success) return refuse('worktree setup output is missing or invalid');
    return parsed.data;
  },
  async apply(ctx) {
    // Never trust a cached detect snapshot for a destructive operation.
    const setup = await noChangeCleanupStep.detect!(ctx);
    const split = splitWorktreePath(setup.worktreePath);
    if (!split || split.anchor !== resolve(ctx.repoPath) || setup.branchName === setup.baseBranch)
      return refuse('the task does not name a separate worktree and branch in this repository');
    if (
      await findWorktreePathClaimant(ctx.db, {
        worktreePath: setup.worktreePath,
        taskId: ctx.taskId,
      })
    )
      return refuse('another task still holds this worktree');
    const branchRef = `refs/heads/${setup.branchName}`;
    const baseRef = `refs/heads/${setup.baseBranch}`;
    const base = await command(
      ctx.repoPath,
      ['rev-parse', '--verify', `${baseRef}^{commit}`],
      'could not read the base commit',
    );
    const branch = await branchHead(ctx.repoPath, branchRef);
    const holders = await worktreesHoldingBranch(ctx.repoPath, branchRef);
    if (holders.some((holder) => holder !== setup.worktreePath))
      return refuse('another checkout holds the branch');
    if (await isWorktreeLocked(ctx.repoPath, setup.worktreePath))
      return refuse('the worktree is locked; unlock it before cleanup');
    const source = await lstatNoFollow(ctx.repoPath, split.rel, { strict: true });
    if (source && source.kind !== 'directory')
      return refuse('the worktree path is not a readable directory');
    const events = await ctx.db.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.taskStepId, ctx.taskStepId),
        eq(schema.taskEvents.eventType, EVENT),
      ),
      orderBy: [desc(schema.taskEvents.createdAt)],
    });
    let journal: Journal | undefined;
    for (const event of events) {
      const parsed = journalSchema.safeParse(event.payload);
      if (!parsed.success) return refuse('the cleanup recovery record is unreadable');
      const saved = parsed.data;
      if (
        saved.worktreePath !== setup.worktreePath ||
        saved.branchName !== setup.branchName ||
        saved.baseBranch !== setup.baseBranch
      )
        return refuse('the worktree setup changed during cleanup');
      const staged = await lstatNoFollow(ctx.repoPath, stageRel(saved), { strict: true });
      if (staged) {
        if (source || !sameIdentity(staged, saved))
          return refuse('the cleanup recovery directory changed');
        journal = saved;
        break;
      }
      if (!source || sameIdentity(source, saved)) {
        journal = saved;
        break;
      }
    }
    let head = branch ?? journal?.head;
    if (!head && source) {
      head = await removedBranchHead(ctx, setup.worktreePath);
    }
    if (head) {
      if (journal && branch && branch !== journal.head)
        return refuse('the branch changed during cleanup');
      const contained = await gitRun(ctx.repoPath, ['merge-base', '--is-ancestor', head, base]);
      if (contained.code === 1) return refuse('branch commits are not contained in the base');
      if (contained.code !== 0) return refuse('could not read branch ancestry');
    }
    if (source) {
      await checkTree(ctx, setup, head!, branch === null);
      if (!journal) {
        journal = {
          ...setup,
          version: 1,
          id: randomUUID(),
          dev: String(source.stats.dev),
          ino: String(source.stats.ino),
          head: head!,
        };
        await record(ctx, journal);
      }
      ctx.throwIfCancelled();
      // An atomic move precedes recursive deletion. The durable inode-bound record survives
      // explicit Retry (which clears apply receipts) and boot recovery. A partially deleted
      // staged tree is never misread as new uncommitted work or adopted by pathname alone.
      const current = await lstatNoFollow(ctx.repoPath, split.rel, { strict: true });
      if (!current || !sameIdentity(current, journal))
        return refuse('the worktree directory changed before removal');
      // A fresh host UUID names the destination. Avoid noReplace's mkdir-then-rename
      // reservation, which a crash between syscalls could leave as an unowned dir.
      await renameNoFollow(ctx.repoPath, split.rel, stageRel(journal), { createParents: true });
    }
    ctx.throwIfCancelled();
    if (journal) {
      const current = await lstatNoFollow(ctx.repoPath, stageRel(journal), { strict: true });
      if (current && !sameIdentity(current, journal))
        return refuse('the cleanup recovery directory changed');
      await removeNoFollow(ctx.repoPath, stageRel(journal), { recursive: true });
    }
    await command(
      ctx.repoPath,
      ['worktree', 'prune', '--expire', 'now'],
      'could not clear the removed worktree registration',
    );
    if (branch) {
      // Compare-and-delete the proven tip, also verifying the base did not rewind.
      // No branch -D, merge, commit or push; no upstream/default-HEAD ancestry shortcut.
      const result = await gitRun(
        ctx.repoPath,
        ['update-ref', '--no-deref', '--stdin'],
        undefined,
        {
          input: Buffer.from(
            `start\nverify ${baseRef} ${base}\ndelete ${branchRef} ${branch}\nprepare\ncommit\n`,
          ),
        },
      );
      if (result.code !== 0) return refuse('the branch or base changed before branch removal');
    }
    return {
      removed: true,
      branchDeleted: true,
      message:
        'Removed the clean worktree and its branch; all branch commits were already contained in the base.',
    };
  },
};
