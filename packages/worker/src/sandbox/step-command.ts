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
import { agentPoolCap } from '../queues/cli-exec/agent-pool-cap.js';
import { resolveAppReach } from '../queues/cli-exec/app-reach.js';
import type { DockerVolumeMount } from './docker-runner.js';
import { SANDBOX_CORE_IMAGE } from './image-composer.js';
import { loopbackForwardSetup } from './loopback-forward.js';
import { NPM_CACHE_ENV, ensureNpmCacheVolume, npmCacheMount } from './npm-cache.js';
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
 *  agent of the pool: it holds an agent lease for the run, and it reaches the task's app and the
 *  shared npm cache as an agent does. Reports `ran: false` when the image has
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
      { db: ctx.db, agentCap: agentPoolCap },
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
    const appReach = await resolveAppReach(ctx.db, ctx.taskId);
    await ensureNpmCacheVolume(sandboxImage ?? SANDBOX_CORE_IMAGE);
    const runnerOptions: Parameters<typeof runInSandbox>[1] = {
      workdir,
      taskId: ctx.taskId,
      invocationId: `lease:${lease.id}`,
    };
    if (sandboxImage) runnerOptions.image = sandboxImage;
    runnerOptions.extraMounts = [...mounts, ...appReach.mounts, npmCacheMount()];
    if (appReach.addHosts.length > 0) runnerOptions.addHosts = appReach.addHosts;
    if (appReach.noProxyHosts.length > 0) runnerOptions.noProxyHosts = appReach.noProxyHosts;
    if (provider.networkPolicy) runnerOptions.networkPolicy = provider.networkPolicy;
    const runSpec: Parameters<typeof runInSandbox>[0] = {
      command: 'sh',
      args: ['-c', preamble, 'sh', ...options.argv],
      env: { ...NPM_CACHE_ENV, ...appReach.env },
      timeoutMs: options.timeoutMs,
      signal: ctx.signal,
    };
    const extraFiles = [...maskFiles];
    if (appReach.loopbackForward) {
      const forward = loopbackForwardSetup(appReach.loopbackForward);
      extraFiles.push(forward.file);
      runSpec.args = ['-c', `${forward.prefix}${preamble}`, 'sh', ...options.argv];
    }
    if (extraFiles.length > 0) runSpec.extraFiles = extraFiles;
    const result = await runInSandbox(runSpec, runnerOptions);
    if (ctx.signal?.aborted) throw new TaskCancelledError();
    if (result.exitCode === BINARY_MISSING_EXIT && result.stdout.includes(marker)) {
      return { ran: false, note: `not run: ${bin} is not in the sandbox image` };
    }
    const output = `${result.stdout}${result.stderr}`;
    if (result.exitCode !== null) return { ran: true, exitCode: result.exitCode, output };
    const why = result.timedOut
      ? `timed out after ${Math.round(options.timeoutMs / 1000)}s`
      : (result.error ?? 'the sandbox run failed');
    return {
      ran: true,
      exitCode: 1,
      output: `${output}\n[sandbox run ended without an exit status: ${why}]\n`,
    };
  } finally {
    await lease.release();
  }
}
