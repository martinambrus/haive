import { loadModuleRoleOutput } from './module-role-read.js';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
import { schema } from '@haive/database';
import {
  isResourceLimitError,
  lstatNoFollow,
  openDirNoFollow,
  relUnder,
} from '@haive/shared/fs-safe';
import { type StepContext, type StepHostServices } from '@haive/shared/step';
import { loadPreviousStepOutput } from './steps/onboarding/_helpers.js';
import { collectImplementationFiles } from './steps/workflow/_impl-changes.js';
import { loadTaskWorktreeDecision, decidedWorktreePath } from '../repo/task-worktree.js';
import { checkHostCancellation, hostCall } from './host-call.js';
import { stepRegistry, type StepRegistry } from './registry.js';
import { pinnedFixTarget, resolvePinnedFixConsumer } from './fix-consumer.js';
import { loadFixLoopRead } from './steps/workflow/_fix-loop.js';
import { readReviewDiff } from './review-diff.js';
import { loadUnactedInsights, validateInsightLimit } from './steps/workflow/_insight-loader.js';

export class StepHostBindingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StepHostBindingError';
  }
}

export function createStepHostServices(
  context: StepContext,
  registry: Pick<StepRegistry, 'get'> = stepRegistry,
): StepHostServices {
  // Capture identity: mutating a consumer's context cannot retarget these capabilities.
  const ctx = { ...context };
  let boundWorktree: string | undefined;
  async function verifyIdentity() {
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
    return { task, step };
  }
  async function bind(requestedPath?: string): Promise<{ resolved: string; held?: FileHandle }> {
    const { task } = await verifyIdentity();
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
    let held: FileHandle | undefined;
    try {
      if (rel) {
        held = await openDirNoFollow(ctx.repoPath, rel);
      } else if ((await lstatNoFollow(ctx.repoPath, '', { strict: true }))?.kind !== 'directory') {
        throw new StepHostBindingError('Context repository directory is unavailable.');
      }
    } catch (error) {
      if (isResourceLimitError(error)) throw error;
      throw new StepHostBindingError('Context worktree directory is unavailable or refused.');
    }
    try {
      checkHostCancellation(ctx);
      return { resolved, held };
    } catch (error) {
      await held?.close();
      throw error;
    }
  }
  return {
    loadFixLoopDiagnosis() {
      return hostCall(ctx, async () => {
        const { task, step } = await verifyIdentity();
        const target = pinnedFixTarget(task.executionContract);
        if (
          !target ||
          target.stepId !== step.stepId ||
          !resolvePinnedFixConsumer(target, registry).ok
        )
          throw new StepHostBindingError('Step is not the pinned fix consumer of this task.');
        return loadFixLoopRead(ctx);
      });
    },
    loadRoleOutput(input) {
      return hostCall(ctx, async () => {
        await verifyIdentity();
        return loadModuleRoleOutput(ctx, input);
      });
    },
    loadUnactedInsights(options) {
      // Capture only supported options before awaiting; callers cannot retarget this capability.
      const captured = { limit: options?.limit, includePicked: options?.includePicked };
      validateInsightLimit(captured.limit);
      return hostCall(ctx, async () => {
        await verifyIdentity();
        return loadUnactedInsights(ctx.db, ctx.taskId, captured);
      });
    },
    loadPreviousStepOutput(stepId) {
      return hostCall(ctx, async () => {
        await verifyIdentity();
        const previous = await loadPreviousStepOutput(ctx.db, ctx.taskId, stepId, ctx.round);
        return previous === null
          ? null
          : {
              detect: previous.detect,
              output: previous.output,
              iterations: previous.iterations,
            };
      });
    },
    collectImplementationFiles(worktreePath) {
      return hostCall(ctx, async () => {
        const { resolved, held } = await bind(worktreePath);
        try {
          const scope = await collectImplementationFiles(ctx, resolved, {
            maxRound: ctx.round,
            signal: ctx.signal,
            propagateResourceErrors: true,
            gitCwd: held ? `/proc/self/fd/${held.fd}` : resolved,
          });
          return {
            ...scope,
            scanError: scope.scanError
              ? scrubErrorPaths(safeErrorMessage(scope.scanError))
              : scope.scanError,
          };
        } finally {
          await held?.close();
        }
      });
    },
    readReviewDiff(options) {
      return hostCall(ctx, async () => {
        const { resolved, held } = await bind(options.worktreePath);
        try {
          return await readReviewDiff(ctx, resolved, options, {
            gitCwd: held ? `/proc/self/fd/${held.fd}` : resolved,
          });
        } finally {
          await held?.close();
        }
      });
    },
  };
}
