import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  isResourceLimitError,
  lstatNoFollow,
  openDirNoFollow,
  relUnder,
} from '@haive/shared/fs-safe';
import { TaskCancelledError, type StepContext, type StepHostServices } from '@haive/shared/step';
import { loadPreviousStepOutput } from './steps/onboarding/_helpers.js';
import { collectImplementationFiles } from './steps/workflow/_impl-changes.js';
import { loadTaskWorktreeDecision, decidedWorktreePath } from '../repo/task-worktree.js';
import { readReviewDiff } from './review-diff.js';

export class StepHostBindingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StepHostBindingError';
  }
}

export function checkHostCancellation(ctx: StepContext): void {
  ctx.throwIfCancelled();
  if (ctx.signal.aborted) throw new TaskCancelledError();
}

/** Normalize aborts to the runner's control class, including during an awaited read.
 * The underlying operation retains its handlers and owns descriptor cleanup. */
export async function hostCall<T>(ctx: StepContext, operation: () => Promise<T>): Promise<T> {
  checkHostCancellation(ctx);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      try {
        checkHostCancellation(ctx);
      } catch (error) {
        reject(error);
      }
    };
    ctx.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([operation(), cancelled]);
    checkHostCancellation(ctx);
    return value;
  } catch (error) {
    checkHostCancellation(ctx);
    throw error;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}

export function createStepHostServices(context: StepContext): StepHostServices {
  // Capture identity: mutating a consumer's context cannot retarget these capabilities.
  const ctx = { ...context };
  let boundWorktree: string | undefined;
  async function bind(requestedPath?: string): Promise<string> {
    checkHostCancellation(ctx);
    if (!Number.isSafeInteger(ctx.round) || ctx.round < 0)
      throw new StepHostBindingError('Invalid context round.');
    const [task, step] = await Promise.all([
      ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }),
      ctx.db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, ctx.taskStepId) }),
    ]);
    checkHostCancellation(ctx);
    if (!task || task.userId !== ctx.userId)
      throw new StepHostBindingError('Task ownership does not match the context.');
    if (
      !step ||
      step.taskId !== ctx.taskId ||
      step.round !== ctx.round ||
      task.currentRound < ctx.round
    )
      throw new StepHostBindingError('Task step or round does not match the context.');
    const decision = await loadTaskWorktreeDecision(ctx.db, {
      taskId: ctx.taskId,
      columnBranch: task.worktreeBranch,
      columnPath: task.worktreePath,
    });
    checkHostCancellation(ctx);
    const worktree = decidedWorktreePath(decision, ctx.repoPath) ?? ctx.repoPath;
    const resolved = path.resolve(worktree);
    if (boundWorktree !== undefined && boundWorktree !== resolved)
      throw new StepHostBindingError('The context worktree changed after binding.');
    boundWorktree = resolved;
    if (requestedPath !== undefined && requestedPath !== resolved)
      throw new StepHostBindingError('worktreePath does not match the context worktree.');
    let rel: string;
    try {
      rel = relUnder(ctx.repoPath, resolved);
    } catch {
      throw new StepHostBindingError('Context worktree is outside its repository.');
    }
    try {
      if (rel) {
        const held = await openDirNoFollow(ctx.repoPath, rel);
        await held.close();
      } else if ((await lstatNoFollow(ctx.repoPath, '', { strict: true }))?.kind !== 'directory') {
        throw new StepHostBindingError('Context repository directory is unavailable.');
      }
    } catch (error) {
      if (isResourceLimitError(error)) throw error;
      throw new StepHostBindingError('Context worktree directory is unavailable or refused.');
    }
    checkHostCancellation(ctx);
    return resolved;
  }
  return {
    loadPreviousStepOutput(stepId) {
      return hostCall(ctx, async () => {
        await bind();
        return loadPreviousStepOutput(ctx.db, ctx.taskId, stepId, ctx.round);
      });
    },
    collectImplementationFiles(worktreePath) {
      return hostCall(ctx, async () => {
        const resolved = await bind(worktreePath);
        return collectImplementationFiles(ctx, resolved, {
          maxRound: ctx.round,
          signal: ctx.signal,
        });
      });
    },
    readReviewDiff(options) {
      return hostCall(ctx, async () => {
        const resolved = await bind(options.worktreePath);
        return readReviewDiff(ctx, resolved, options);
      });
    },
  };
}
