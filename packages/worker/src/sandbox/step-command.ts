import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { TaskCancelledError, type StepContext } from '../step-engine/step-definition.js';
import { resolveInvocationRepoMount, resolveSandboxImageTag } from '../queues/cli-exec-queue.js';
import { resolveSecretMasks } from '../queues/cli-exec/secret-mask.js';
import { repoGitDataBoundary } from '../queues/cli-exec/gitfile-mask.js';
import {
  AgentLeaseAbortedError,
  AgentLeaseTimeoutError,
  acquireAgentLease,
  type AgentLease,
} from '../queues/cli-exec/agent-lease.js';
import { currentAgentCap } from '../queues/cli-exec/handlers.js';
import type { DockerVolumeMount } from './docker-runner.js';
import { runInSandbox, SANDBOX_WORKDIR } from './sandbox-runner.js';

/** Exit status of the Haive-owned preamble when the command's binary is not on the image's PATH,
 *  taken as that only together with the run's own marker on stdout: a command may exit 199 itself. */
export const BINARY_MISSING_EXIT = 199;

function missingBinaryGuard(): { marker: string; preamble: string } {
  const marker = `step-bin-missing-${randomBytes(8).toString('hex')}`;
  return {
    marker,
    preamble: `command -v "$1" >/dev/null 2>&1 || { echo ${marker}; exit ${BINARY_MISSING_EXIT}; }; exec "$@"`,
  };
}

export interface StepCommandOptions {
  argv: string[];
  /** Directory to run in, relative to the worktree root. */
  cwdRel?: string;
  timeoutMs: number;
  onWait?: (busy: number, cap: number) => void;
}

export type StepCommandResult =
  { ran: false; note: string } | { ran: true; exitCode: number; output: string };

/** Run one command of a step (a project's test, lint or typecheck) in the task's sandbox, as one
 *  agent of the pool: it holds an agent lease for the run. Reports `ran: false` when the image has
 *  no such binary rather than failing the project's check. No auth volume and no provider env are
 *  passed: the project's own code runs here, and has no use for the CLI's credentials. */
export async function runStepCommandInSandbox(
  ctx: StepContext,
  options: StepCommandOptions,
): Promise<StepCommandResult> {
  const [bin] = options.argv;
  if (!bin) throw new Error('runStepCommandInSandbox needs a command');
  if (!ctx.cliProviderId) {
    return { ran: false, note: 'not run: no CLI provider, so no sandbox image' };
  }
  const provider = await ctx.db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, ctx.cliProviderId),
  });
  if (!provider) {
    return { ran: false, note: `not run: CLI provider ${ctx.cliProviderId} not found` };
  }

  const workdir = path.posix.join(SANDBOX_WORKDIR, options.cwdRel ?? '');
  if (workdir !== SANDBOX_WORKDIR && !workdir.startsWith(`${SANDBOX_WORKDIR}/`)) {
    throw new Error(`cwdRel ${options.cwdRel} leaves the worktree`);
  }

  const sandboxImage = await resolveSandboxImageTag(ctx.db, ctx.taskId, provider);
  const { repoMount, hasWorktree, hasRepo } = await resolveInvocationRepoMount(ctx.db, ctx.taskId);
  const gitData = await repoGitDataBoundary(repoMount, { hasWorktree, hasRepo });
  const mounts: DockerVolumeMount[] = [...gitData.mounts];
  if (repoMount) mounts.push(repoMount);
  const maskFiles = [
    ...(await resolveSecretMasks(ctx.db, ctx.taskId, repoMount)),
    ...gitData.masks,
  ];

  let lease: AgentLease;
  try {
    lease = await acquireAgentLease(
      { db: ctx.db, agentCap: currentAgentCap },
      { signal: ctx.signal, ...(options.onWait ? { onWait: options.onWait } : {}) },
    );
  } catch (err) {
    if (err instanceof AgentLeaseTimeoutError) {
      return { ran: false, note: `not run: ${err.message}` };
    }
    if (err instanceof AgentLeaseAbortedError) throw new TaskCancelledError();
    throw err;
  }
  const { marker, preamble } = missingBinaryGuard();
  try {
    const runnerOptions: Parameters<typeof runInSandbox>[1] = {
      workdir,
      taskId: ctx.taskId,
      invocationId: `lease:${lease.id}`,
    };
    if (sandboxImage) runnerOptions.image = sandboxImage;
    if (mounts.length > 0) runnerOptions.extraMounts = mounts;
    if (provider.networkPolicy) runnerOptions.networkPolicy = provider.networkPolicy;
    const runSpec: Parameters<typeof runInSandbox>[0] = {
      command: 'sh',
      args: ['-c', preamble, 'sh', ...options.argv],
      timeoutMs: options.timeoutMs,
      signal: ctx.signal,
    };
    if (maskFiles.length > 0) runSpec.extraFiles = maskFiles;
    const result = await runInSandbox(runSpec, runnerOptions);
    if (result.exitCode === BINARY_MISSING_EXIT && result.stdout.includes(marker)) {
      return { ran: false, note: `not run: ${bin} is not in the sandbox image` };
    }
    return {
      ran: true,
      exitCode: result.exitCode ?? 1,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    await lease.release();
  }
}
