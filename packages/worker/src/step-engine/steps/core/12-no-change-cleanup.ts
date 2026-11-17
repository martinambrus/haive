import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import {
  lstatNoFollow,
  openFileNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';
import {
  EVENT,
  setupSchema,
  journalSchema,
  refuse,
  stageRel,
  sameIdentity,
  type Setup,
  type Journal,
} from '../../no-change-cleanup.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { assertOwnsStep, StepSupersededError, taskWriteTarget } from '../../step-ownership.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { gitRun } from '../../../repo/git-exec.js';
import { gitOperationMarker } from '../../../repo/git-operation.js';
import { isWorktreeLocked, worktreesHoldingBranch } from '../../../repo/git-workspace.js';
import { readUncommittedChanges } from '../../../repo/worktree-changes.js';
import { findWorktreePathClaimant } from '../../../repo/worktree-claims.js';
import { splitWorktreePath } from '../../../repo/worktree-paths.js';

const command = async (dir: string, args: string[], reason: string) => {
  const result = await gitRun(dir, args);
  if (result.code !== 0) refuse(reason);
  return result.stdout.trim();
};

/** Step first, task last, like Retry. Keep the fence through each filesystem/ref mutation;
 * no pool reads or writes may be made by fn while this transaction holds those rows. */
async function ownedCleanup<T>(ctx: StepContext, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    await assertOwnsStep(tx, ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(taskWriteTarget(ctx.taskId, ctx.epoch == null ? undefined : { epoch: ctx.epoch }))
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    ctx.throwIfCancelled();
    return fn(tx);
  });
}

async function record(ctx: StepContext, journal: Journal): Promise<void> {
  await ownedCleanup(ctx, async (tx) => {
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

/** A moved submodule's core.worktree still names its old location. Check each index
 *  separately at its relocated path, overriding core.worktree for this command only.
 *  Superproject diffs ignore submodule working directories; the cached diff still checks
 *  gitlink changes, and recursion checks each initialized submodule's HEAD, index and files.
 *  No repository config is rewritten, including on a failed check or crash recovery. */
async function checkRelocatedTree(ctx: StepContext, dir: string, head: string): Promise<void> {
  const prefix = [
    '--no-optional-locks',
    `--work-tree=${dir}`,
    '-c',
    'core.trustctime=true',
    '-c',
    'core.checkStat=default',
    '-c',
    'core.fileMode=true',
  ];
  const flags = await command(
    dir,
    [...prefix, 'ls-files', '-v', '-z'],
    'the worktree index is unreadable',
  );
  if (flags.split('\0').some((entry) => /^([a-z]|S) /.test(entry)))
    refuse('the worktree index is unreadable');
  for (const args of [
    ['diff', '--cached', '--quiet', '--ignore-submodules=none', head, '--'],
    ['diff', '--quiet', '--ignore-submodules=all', head, '--'],
  ]) {
    const diff = await gitRun(dir, [...prefix, ...args]);
    if (diff.code === 1) refuse('the worktree holds uncommitted changes');
    if (diff.code !== 0) refuse('the worktree is unreadable');
  }
  if (
    await command(
      dir,
      [...prefix, 'ls-files', '--others', '--exclude-standard', '-z'],
      'the worktree is unreadable',
    )
  )
    refuse('the worktree holds uncommitted changes');
  const entries = await command(
    dir,
    [...prefix, 'ls-files', '--stage', '-z'],
    'the worktree index is unreadable',
  );
  for (const entry of entries.split('\0')) {
    const gitlink = /^160000 ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(entry);
    if (!gitlink) continue;
    const child = resolve(dir, gitlink[2]!);
    const gitfile = await lstatNoFollow(ctx.repoPath, relative(ctx.repoPath, `${child}/.git`), {
      strict: true,
    });
    // Git permits uninitialized submodules. Their absent gitfile owes no nested index check.
    if (!gitfile) continue;
    if (gitfile.kind !== 'file' && gitfile.kind !== 'directory')
      refuse('the submodule gitfile is unreadable');
    // Relative gitfiles rely on equal depth: .haive/no-change-cleanup/<uuid> vs .haive/worktrees/<name>.
    const childHead = await command(
      child,
      [`--work-tree=${child}`, 'rev-parse', '--verify', 'HEAD^{commit}'],
      'the submodule HEAD is unreadable',
    );
    if (childHead !== gitlink[1]) refuse('the worktree holds uncommitted changes');
    await checkRelocatedTree(ctx, child, childHead);
  }
}

async function checkTreeChanges(
  ctx: StepContext,
  setup: Setup,
  head: string,
  branchAbsent: boolean,
  relocated = false,
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
    if (relocated) return checkRelocatedTree(ctx, dir, head);
    const changes = await readUncommittedChanges(dir, 0);
    if (changes === null) return refuse('the worktree is unreadable');
    if (changes.count !== 0) refuse('the worktree holds uncommitted changes');
    return;
  }
  if (!branchAbsent || liveHead.code !== 1) return refuse('the worktree HEAD is unreadable');
  if (relocated) return checkRelocatedTree(ctx, dir, head);
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

/** Pruning a worktree also drops its submodule admin dirs, including every ref, stash
 *  and object. Prove those commits survive outside those dirs before authorizing deletion.
 *  Remote-tracking refs are the local evidence; no network or persistent config writes.
 *  A base gitlink is no evidence: it records a commit id, not the objects, and the only
 *  copy of that commit can be the object store this prune deletes. */
async function checkSubmoduleHistory(ctx: StepContext, dir: string): Promise<void> {
  const prefix = ['--no-optional-locks', `--work-tree=${dir}`];
  const entries = await command(
    dir,
    [...prefix, 'ls-files', '--stage', '-z'],
    'the submodule index is unreadable',
  );
  if (!entries.split('\0').some((entry) => entry.startsWith('160000 '))) return;
  for (const entry of entries.split('\0')) {
    const link = /^160000 ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(entry);
    if (!link) continue;
    const child = resolve(dir, link[2]!);
    const gitfile = await lstatNoFollow(ctx.repoPath, relative(ctx.repoPath, `${child}/.git`), {
      strict: true,
    });
    if (!gitfile) continue;
    if (gitfile.kind !== 'file' && gitfile.kind !== 'directory')
      refuse('the submodule gitfile is unreadable');
    const childPrefix = ['--no-optional-locks', `--work-tree=${child}`];
    const remotes = await command(
      child,
      [...childPrefix, 'remote'],
      'the submodule remotes are unreadable',
    );
    if (!remotes) refuse('the submodule has no remote to retain its commits');
    const unretained = await command(
      child,
      [...childPrefix, 'rev-list', '--max-count=1', '--all', 'HEAD', '--not', '--remotes'],
      'the submodule history is unreadable',
    );
    if (unretained)
      refuse('the submodule holds commits not reachable from its remote-tracking refs');
    await checkSubmoduleHistory(ctx, child);
  }
}

async function checkTree(
  ctx: StepContext,
  setup: Setup,
  head: string,
  branchAbsent: boolean,
  relocated = false,
): Promise<void> {
  await checkTreeChanges(ctx, setup, head, branchAbsent, relocated);
  await checkSubmoduleHistory(ctx, setup.worktreePath);
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
      'Removes a clean task worktree and its branch only when the base already contains every branch commit. Ignored files are removed too.',
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
    const source = await lstatNoFollow(ctx.repoPath, split.rel, { strict: true, bigint: true });
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
    let hasStaged = false;
    for (const event of events) {
      const parsed = journalSchema.safeParse(event.payload);
      if (!parsed.success) return refuse('the cleanup recovery record is unreadable');
      const saved = parsed.data;
      const staged = await lstatNoFollow(ctx.repoPath, stageRel(saved), {
        strict: true,
        bigint: true,
      });
      if (
        saved.worktreePath !== setup.worktreePath ||
        saved.branchName !== setup.branchName ||
        saved.baseBranch !== setup.baseBranch
      ) {
        const oldSource = await lstatNoFollow(
          ctx.repoPath,
          relative(ctx.repoPath, saved.worktreePath),
          { strict: true, bigint: true },
        );
        if (staged || (oldSource && sameIdentity(oldSource, saved)))
          return refuse('the worktree setup changed during cleanup');
        continue;
      }
      if (staged) {
        if (source || !sameIdentity(staged, saved))
          return refuse('the cleanup recovery directory changed');
        journal = saved;
        hasStaged = true;
        break;
      }
      if (!source || sameIdentity(source, saved)) {
        journal = saved;
        break;
      }
    }
    let head = branch ?? journal?.head;
    if (!branch && source) {
      head = await removedBranchHead(ctx, setup.worktreePath);
    }
    if (head && (source || hasStaged || branch)) {
      if (hasStaged && journal && branch && branch !== journal.head)
        return refuse('the branch changed during cleanup');
      const contained = await gitRun(ctx.repoPath, ['merge-base', '--is-ancestor', head, base]);
      if (contained.code === 1) return refuse('branch commits are not contained in the base');
      if (contained.code !== 0) return refuse('could not read branch ancestry');
    }
    if (source) {
      await checkTree(ctx, setup, head!, branch === null);
      if (!journal || journal.head !== head || journal.phase !== 'staging') {
        journal = {
          ...setup,
          version: 1,
          phase: 'staging',
          id: randomUUID(),
          dev: String(source.stats.dev),
          ino: String(source.stats.ino),
          head: head!,
        };
        await record(ctx, journal);
      }
    }
    await ownedCleanup(ctx, async (tx) => {
      if (source && journal) {
        // The journal transaction can wait on locks. Check again after it, immediately
        // before the identity probe and move, rather than relying on the earlier read.
        await checkTree(ctx, setup, head!, branch === null);
        // An atomic move precedes recursive deletion. The durable inode-bound record survives
        // explicit Retry (which clears apply receipts) and boot recovery. A partially deleted
        // staged tree is never misread as new uncommitted work or adopted by pathname alone.
        const current = await lstatNoFollow(ctx.repoPath, split.rel, {
          strict: true,
          bigint: true,
        });
        if (!current || !sameIdentity(current, journal))
          return refuse('the worktree directory changed before removal');
        // A fresh host UUID names the destination. Avoid noReplace's mkdir-then-rename
        // reservation, which a crash between syscalls could leave as an unowned dir.
        await renameNoFollow(ctx.repoPath, split.rel, stageRel(journal), { createParents: true });
      }
      if (journal?.phase === 'staging' && (source || hasStaged)) {
        const staged = await lstatNoFollow(ctx.repoPath, stageRel(journal), {
          strict: true,
          bigint: true,
        });
        if (!staged || !sameIdentity(staged, journal))
          return refuse('the cleanup recovery directory changed');
        try {
          // Its gitfile still locates the admin dir after the move. This also checks
          // a crash after rename but before the verification/removal authorization.
          await checkTree(
            ctx,
            { ...setup, worktreePath: resolve(ctx.repoPath, stageRel(journal)) },
            head!,
            branch === null,
            true,
          );
        } catch (error) {
          try {
            await renameNoFollow(ctx.repoPath, stageRel(journal), split.rel, { noReplace: true });
          } catch {
            return refuse(
              `the staged worktree could not be restored; recover it from ${stageRel(journal)}`,
            );
          }
          throw error;
        }
        journal = { ...journal, phase: 'removing' };
        await tx.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: ctx.taskStepId,
          eventType: EVENT,
          payload: journal,
        });
      }
    });
    // Commit authorization before the first unlink. A crash/failed removal can then
    // resume a partial tree, while an unverified move must still pass the clean check.
    await ownedCleanup(ctx, async () => {
      ctx.throwIfCancelled();
      if (journal) {
        const current = await lstatNoFollow(ctx.repoPath, stageRel(journal), {
          strict: true,
          bigint: true,
        });
        if (current && !sameIdentity(current, journal))
          return refuse('the cleanup recovery directory changed');
        await removeNoFollow(ctx.repoPath, stageRel(journal), {
          recursive: true,
          repairPermissions: true,
          expectedDirectory: { dev: BigInt(journal.dev), ino: BigInt(journal.ino) },
        });
      }
      // Git prune has no worktree/path argument. This repo-wide registration sweep
      // matches 01-worktree-setup and removeWorktreeDir; it deletes no live tree.
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
    });
    return {
      removed: true,
      branchDeleted: true,
      message:
        'Removed the clean worktree and its branch; all branch commits were already contained in the base.',
    };
  },
};
