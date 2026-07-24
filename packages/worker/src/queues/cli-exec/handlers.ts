import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DelayedError, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import {
  CLI_EXEC_JOB_NAMES,
  CONFIG_CONCURRENCY_CHANNEL,
  CONFIG_KEYS,
  CONFIG_RUNTIME_LIMITS_CHANNEL,
  QUEUE_NAMES,
  cliAuthProviderVolumeName,
  cliAuthVolumeName,
  configService,
  createRedisConnection,
  getCliProviderMetadata,
  type CliExecJobPayload,
  type CliLoginCreateJobPayload,
  type CliLoginCreateResult,
  type CliProbeJobPayload,
  type CliProbeResult,
  type CliProviderName,
  type CliSignOutJobPayload,
  type CliSignOutJobResult,
  type RefreshCliVersionsJobPayload,
  type RefreshCliVersionsJobResult,
  type SandboxImageBuildJobPayload,
  type SandboxImageBuildResult,
  type OllamaProvisionJobPayload,
  type OllamaProvisionResult,
} from '@haive/shared';
import { resolveAgentConcurrency } from '../../sandbox/runtime-admission.js';
import { refreshAllCliVersions, refreshAllToolVersions } from '../../cli-versions/index.js';
import { defaultDockerRunner, type DockerRunner } from '../../sandbox/docker-runner.js';
import { renderDockerfile, resolveImageTag } from '../../sandbox/image-cache.js';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
import { resolveProviderSecrets } from '../../secrets/provider-secrets.js';
import { provisionOllamaProvider } from '../../sandbox/ollama-provision.js';
import { resolveGitEnv } from '../../secrets/user-git-identity.js';
import { createSandboxLoginContainer } from '../../sandbox/login-container.js';
import { buildSetupTokenCommand } from '../../cli-adapters/setup-token-command.js';
import { getDb } from '../../db.js';
import { getBullRedis } from '../../redis.js';
import { publishCliExit } from '../cli-stream-publisher.js';
import {
  CliLoginRequiredError,
  defaultDeps,
  getCliExecQueue,
  log,
  type CliExecDeps,
  type CliExecQueuePayload,
} from './_shared.js';
import { executeByKind, interpretCliFailure } from './exec-core.js';
import {
  resolveProviderNameForPayload,
  resumeStepIfLinked,
  STATUS_DEFAULT_MESSAGE,
} from './resolvers.js';
import { markProvidersReady, probeCliPath, removeOrphanedPreviousImage } from './images.js';
import { foldCliParkOnResume, markCliParkBegin } from '../cli-park-timing.js';

export async function handleCliExecJob(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps = defaultDeps,
): Promise<void> {
  const row = await db.query.cliInvocations.findFirst({
    where: eq(schema.cliInvocations.id, payload.invocationId),
  });
  if (!row) {
    log.warn({ invocationId: payload.invocationId }, 'cli invocation row missing');
    return;
  }
  // A redelivered job whose invocation was already finalized — cancelled by the
  // user (cancel-active-cli sets ended+superseded) or superseded by a step retry
  // — must NOT re-run: that would spawn a fresh sandbox and burn a CLI call for a
  // row the user already stopped.
  if (row.endedAt || row.supersededAt) {
    log.info(
      { invocationId: payload.invocationId },
      'cli invocation already finalized; skipping redelivery',
    );
    return;
  }

  await db
    .update(schema.cliInvocations)
    // Run truly begins here. Overwrite any "Queued — machine at capacity" text
    // (set at enqueue) with the live default, so a multi-invocation step's blue
    // status banner shows "Waiting for AI analysis…" instead of the stale queued
    // message; the statusUpdater later refines it to the actual tool/activity.
    .set({ startedAt: new Date(), statusMessage: STATUS_DEFAULT_MESSAGE })
    .where(eq(schema.cliInvocations.id, row.id));

  // Work resumed: this invocation is now running, so close any waiting_cli park the step
  // accrued (initial queue wait, or a rate-limit/allowance park between waves) by folding
  // the elapsed span into idle_ms. Guarded/atomic — the first invocation of a parallel batch
  // folds; the rest no-op.
  if (payload.taskStepId) await foldCliParkOnResume(db, payload.taskStepId);

  if (payload.agentMiningId) {
    await db
      .update(schema.taskStepAgentMinings)
      .set({
        status: 'running',
        startedAt: new Date(),
        cliInvocationId: row.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.taskStepAgentMinings.id, payload.agentMiningId));
  }

  const providerSecrets = payload.cliProviderId
    ? await resolveProviderSecrets(db, payload.cliProviderId)
    : {};
  const gitEnv = await resolveGitEnv(db, { userId: payload.userId, taskId: payload.taskId });
  const secrets: Record<string, string> = { ...gitEnv, ...providerSecrets };

  const startedAt = Date.now();
  try {
    const result = await executeByKind(db, payload, deps, secrets);
    const durationMs = Date.now() - startedAt;

    const providerName = await resolveProviderNameForPayload(db, payload);
    const finalErrorMessage = interpretCliFailure(result, providerName);

    await publishCliExit(payload.invocationId, result.exitCode);

    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: result.exitCode,
        rawOutput: result.rawOutput,
        streamLog: result.streamLog ?? null,
        parsedOutput: result.parsedOutput as unknown,
        tokenUsage: result.tokenUsage ?? null,
        durationMs,
        errorMessage: finalErrorMessage,
        endedAt: new Date(),
      })
      .where(eq(schema.cliInvocations.id, row.id));

    // Best-effort per-step summarizer: write task_steps.summary and stop. This
    // invocation is unlinked (taskStepId=null) so it must not resume the step.
    if (payload.purpose === 'step_summary') {
      const summaryText = (result.rawOutput ?? '').trim().slice(0, 2000);
      if (payload.summaryForStepId && result.exitCode === 0 && summaryText) {
        await db
          .update(schema.taskSteps)
          .set({ summary: summaryText, updatedAt: new Date() })
          .where(eq(schema.taskSteps.id, payload.summaryForStepId));
      }
      return;
    }

    if (payload.agentMiningId) {
      const failed = result.exitCode !== 0 || (finalErrorMessage?.trim().length ?? 0) > 0;
      await db
        .update(schema.taskStepAgentMinings)
        .set({
          status: failed ? 'failed' : 'done',
          output: result.parsedOutput as unknown,
          rawOutput: result.rawOutput,
          errorMessage: finalErrorMessage,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.taskStepAgentMinings.id, payload.agentMiningId));
    }

    // Park-begin candidate: this invocation just ended. If it was the last one running for
    // the step and the step is still waiting_cli (didn't advance — a rate-limit/allowance
    // failure, or more agents still queued), stamp the wait so the ensuing gap bills as idle,
    // not work. Guarded/atomic — no-ops while any sibling invocation is still running.
    if (payload.taskStepId) await markCliParkBegin(db, payload.taskStepId);

    await resumeStepIfLinked(payload, result.exitCode === 0, finalErrorMessage);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, invocationId: payload.invocationId }, 'cli exec failed');
    await publishCliExit(payload.invocationId, -1);
    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: -1,
        errorMessage: message,
        durationMs,
        endedAt: new Date(),
      })
      .where(eq(schema.cliInvocations.id, row.id));
    // Summarizer is best-effort: on failure leave summary null and do not resume or
    // retry (taskStepId is null so resumeStepIfLinked is a no-op anyway).
    if (payload.purpose === 'step_summary') return;
    if (payload.agentMiningId) {
      await db
        .update(schema.taskStepAgentMinings)
        .set({
          status: 'failed',
          errorMessage: message,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.taskStepAgentMinings.id, payload.agentMiningId));
    }
    if (err instanceof CliLoginRequiredError && payload.taskStepId) {
      await db
        .update(schema.taskSteps)
        .set({ errorHint: err.hint, updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, payload.taskStepId));
    }
    // Park-begin candidate (mirror of the success path): a failed invocation — including a
    // rate-limit/allowance fatal — that leaves the step in waiting_cli should have the ensuing
    // wait billed as idle, not work.
    if (payload.taskStepId) await markCliParkBegin(db, payload.taskStepId);
    await resumeStepIfLinked(payload, false, message);
    throw err;
  }
}

export async function handleProbeJob(
  db: Database,
  payload: CliProbeJobPayload,
): Promise<CliProbeResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) {
    return {
      ok: false,
      providerId: payload.providerId,
      targetMode: 'cli',
      cli: { ok: false, error: 'provider not found' },
    };
  }

  if (!cliAdapterRegistry.has(provider.name)) {
    return {
      ok: false,
      providerId: payload.providerId,
      targetMode: 'cli',
      cli: { ok: false, error: `no adapter registered for ${provider.name}` },
    };
  }
  const adapter = cliAdapterRegistry.get(provider.name);
  const secrets = await resolveProviderSecrets(db, payload.providerId);

  const cli = await probeCliPath(db, adapter, provider, secrets);
  const result: CliProbeResult = {
    ok: cli.ok === true,
    providerId: payload.providerId,
    targetMode: 'cli',
    cli,
  };

  if (cli.authStatus) {
    await db
      .update(schema.cliProviders)
      .set({
        authStatus: cli.authStatus,
        authMessage: cli.authMessage ?? null,
        authLastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
  }

  return result;
}

export async function handleBuildSandboxImageJob(
  db: Database,
  payload: SandboxImageBuildJobPayload,
): Promise<SandboxImageBuildResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) {
    return { ok: false, providerId: payload.providerId, error: 'provider not found' };
  }

  const cliVersion = provider.cliVersion?.trim() || null;
  const resolution = resolveImageTag({
    name: provider.name as CliProviderName,
    cliVersion,
    providerId: provider.id,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });

  if (!resolution) {
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageTag: null,
        sandboxImageBuildStatus: 'idle',
        sandboxImageBuildError: null,
        sandboxImageBuiltAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.info(
      { providerId: provider.id },
      'sandbox image build skipped (no install lines, no extras)',
    );
    return { ok: true, providerId: provider.id };
  }

  const { tag: imageTag, shared } = resolution;
  const previousDbTag = provider.sandboxImageTag;

  await db
    .update(schema.cliProviders)
    .set({
      sandboxImageTag: imageTag,
      sandboxImageBuildStatus: 'building',
      sandboxImageBuildError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.cliProviders.id, provider.id));

  if (!payload.force) {
    const existing = await defaultDockerRunner.inspect(imageTag);
    if (existing.exists) {
      await markProvidersReady(db, imageTag, provider.id, shared);
      await removeOrphanedPreviousImage(db, {
        providerId: provider.id,
        previousDbTag,
        newTag: imageTag,
      });
      log.info({ providerId: provider.id, imageTag, shared }, 'sandbox image cache hit');
      return { ok: true, providerId: provider.id, imageTag };
    }
  }

  const previousInspect = await defaultDockerRunner.inspect(imageTag);
  const previousImageId = previousInspect.exists ? previousInspect.imageId : null;

  const dockerfileContent = renderDockerfile(resolution);
  const buildDir = join(tmpdir(), `haive-sandbox-build-${randomUUID()}`);
  const dockerfilePath = join(buildDir, 'Dockerfile');

  try {
    await mkdir(buildDir, { recursive: true });
    await writeFile(dockerfilePath, dockerfileContent, 'utf8');

    log.info({ providerId: provider.id, imageTag, shared }, 'building sandbox image');
    const result = await defaultDockerRunner.build({
      contextDir: buildDir,
      dockerfilePath,
      tag: imageTag,
      timeoutMs: 20 * 60 * 1000,
    });

    if (result.exitCode === 0) {
      await markProvidersReady(db, imageTag, provider.id, shared);
      await removeOrphanedPreviousImage(db, {
        providerId: provider.id,
        previousDbTag,
        newTag: imageTag,
      });
      if (previousImageId && result.imageId && previousImageId !== result.imageId) {
        const removeResult = await defaultDockerRunner.remove(previousImageId);
        if (!removeResult.ok) {
          log.warn(
            {
              providerId: provider.id,
              imageTag,
              previousImageId,
              stderr: removeResult.stderr,
              error: removeResult.error,
            },
            'failed to remove previous sandbox image',
          );
        } else {
          log.info(
            { providerId: provider.id, imageTag, previousImageId },
            'removed previous sandbox image',
          );
        }
      }
      log.info(
        { providerId: provider.id, imageTag, durationMs: result.durationMs },
        'sandbox image build succeeded',
      );
      return {
        ok: true,
        providerId: provider.id,
        imageTag,
        durationMs: result.durationMs,
      };
    }

    const errMsg = (result.error ?? result.stderr ?? `exit ${result.exitCode}`).slice(-4000);
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageBuildStatus: 'failed',
        sandboxImageBuildError: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.warn(
      { providerId: provider.id, imageTag, exitCode: result.exitCode },
      'sandbox image build failed',
    );
    return {
      ok: false,
      providerId: provider.id,
      error: errMsg,
      durationMs: result.durationMs,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.cliProviders)
      .set({
        sandboxImageBuildStatus: 'failed',
        sandboxImageBuildError: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
    log.error({ err, providerId: provider.id }, 'sandbox image build threw');
    return { ok: false, providerId: provider.id, error: errMsg };
  } finally {
    rm(buildDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn({ err, buildDir }, 'failed to cleanup sandbox build dir');
    });
  }
}

export async function handleRefreshCliVersionsJob(
  db: Database,
): Promise<RefreshCliVersionsJobResult> {
  const [cli, tools] = await Promise.all([refreshAllCliVersions(db), refreshAllToolVersions(db)]);
  return {
    ok: cli.ok && tools.ok,
    refreshed: [...cli.refreshed, ...tools.refreshed],
    errors: [...cli.errors, ...tools.errors],
  };
}

export async function handleLoginCreateJob(
  db: Database,
  payload: CliLoginCreateJobPayload,
): Promise<CliLoginCreateResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) return { ok: false, error: 'provider not found' };
  if (provider.userId !== payload.userId) {
    return { ok: false, error: 'provider not owned by user' };
  }
  if (!cliAdapterRegistry.has(provider.name)) {
    return { ok: false, error: `no adapter registered for ${provider.name}` };
  }

  const adapter = cliAdapterRegistry.get(provider.name);
  const executable =
    provider.wrapperPath?.trim() || provider.executablePath?.trim() || adapter.defaultExecutable;

  let commandSpec;
  try {
    commandSpec = buildSetupTokenCommand(provider, executable);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Ensure the per-user auth volume(s) are owned by the sandbox user (uid 1000)
  // before the login container (which runs as `node`) mounts them. Docker
  // creates fresh named-volume mountpoints root-owned, which blocks native CLIs
  // such as agy from writing their credential files on first login. Mirrors the
  // chown ensureTaskAuthVolumes performs for per-task volumes; creates the empty
  // volume node-owned if it does not exist yet. Best-effort: failures are logged.
  const authHelperImage = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
  const authMeta = getCliProviderMetadata(provider.name);
  for (let idx = 0; idx < authMeta.authConfigPaths.length; idx += 1) {
    const vol = provider.isolateAuth
      ? cliAuthProviderVolumeName(provider.id, provider.name, idx)
      : cliAuthVolumeName(provider.userId, provider.name, idx);
    try {
      const chownRes = await defaultDockerRunner.run({
        image: authHelperImage,
        cmd: ['sh', '-c', 'chown -R 1000:1000 /v'],
        mounts: [{ source: vol, target: '/v', readOnly: false }],
        entrypoint: '',
        user: 'root',
        timeoutMs: 30_000,
      });
      if (chownRes.exitCode !== 0) {
        log.warn(
          { vol, exitCode: chownRes.exitCode, stderr: chownRes.stderr.slice(-200) },
          'login auth volume chown exited non-zero',
        );
      }
    } catch (err) {
      log.warn({ err, vol }, 'login auth volume chown failed');
    }
  }

  try {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker();
    const created = await createSandboxLoginContainer(db, {
      provider,
      commandSpec,
      docker,
    });
    return {
      ok: true,
      containerRowId: created.containerRowId,
      dockerContainerId: created.dockerContainerId,
    };
  } catch (err) {
    log.error({ err, providerId: provider.id }, 'login container create failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleSignOutJob(
  db: Database,
  payload: CliSignOutJobPayload,
  runner: DockerRunner = defaultDockerRunner,
): Promise<CliSignOutJobResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) return { ok: false, removed: [], failed: [] };
  if (provider.userId !== payload.userId) {
    return { ok: false, removed: [], failed: [] };
  }

  const meta = getCliProviderMetadata(provider.name);
  const removed: string[] = [];
  const failed: { name: string; stderr: string }[] = [];
  for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
    const name = provider.isolateAuth
      ? cliAuthProviderVolumeName(provider.id, provider.name, idx)
      : cliAuthVolumeName(provider.userId, provider.name, idx);
    if (!(await runner.volumeExists(name))) continue;
    const result = await runner.volumeRemove(name);
    if (result.ok) removed.push(name);
    else failed.push({ name, stderr: result.stderr });
  }

  // Claude's subscription login lives in the env-injected CLAUDE_CODE_OAUTH_TOKEN secret
  // (the login flow even strips it out of envVars), NOT in a volume file — so removing
  // volumes alone leaves the provider authenticated and the next login skips browser auth.
  // Delete the login + usage-tracking token secrets to log out for real. A user-entered
  // BYOK key (apiKeyEnvName, e.g. ANTHROPIC_AUTH_TOKEN) is not a login artifact -> kept.
  if (provider.name === 'claude-code') {
    await db
      .delete(schema.cliProviderSecrets)
      .where(
        and(
          eq(schema.cliProviderSecrets.providerId, provider.id),
          inArray(schema.cliProviderSecrets.secretName, [
            'CLAUDE_CODE_OAUTH_TOKEN',
            CLAUDE_USAGE_OAUTH_SECRET,
          ]),
        ),
      );
  }

  if (failed.length === 0) {
    await db
      .update(schema.cliProviders)
      .set({
        authStatus: 'unknown',
        authMessage: null,
        authLastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviders.id, provider.id));
  }

  log.info(
    { providerId: provider.id, removedCount: removed.length, failedCount: failed.length },
    'cli sign-out completed',
  );
  return { ok: failed.length === 0, removed, failed };
}

const VERSION_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const VERSION_REFRESH_JOB_ID = 'cli-refresh-versions-repeatable';

export async function scheduleCliVersionRefresh(): Promise<void> {
  const queue = getCliExecQueue();
  await queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    { force: false } satisfies RefreshCliVersionsJobPayload,
    {
      repeat: { every: VERSION_REFRESH_INTERVAL_MS },
      jobId: VERSION_REFRESH_JOB_ID,
      removeOnComplete: true,
      removeOnFail: 10,
    },
  );
  await queue.add(
    CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
    { force: true } satisfies RefreshCliVersionsJobPayload,
    { removeOnComplete: true, removeOnFail: 10 },
  );
}

/** Concurrency used when config is unavailable, or when the resource governor is off and there
 *  is no budget to size against. The pre-feature fixed value. */
const STATIC_PARALLEL_AGENTS = 3;

/** How often auto-sized concurrency re-reads the runtime pool. Runners come and go outside any
 *  config change (a boot, a teardown, the reaper), and none of those publish on the concurrency
 *  channel — without this poll the agent pool would only retune when an admin touched a setting. */
const AGENT_CONCURRENCY_POLL_MS = 30_000;

/** Floor the parallel-agent cap at 1 (BullMQ requires concurrency >= 1). No upper
 *  limit — the host operator sets it to whatever their machine can handle. */
function clampParallelCap(n: number): number {
  if (!Number.isFinite(n)) return STATIC_PARALLEL_AGENTS;
  return Math.max(1, Math.floor(n));
}

/** Pull/build a provider's in-stack Ollama model after a create/edit so it is
 *  ready without a worker restart. Delegates to provisionOllamaProvider, which
 *  updates model_provision_status. No-op for non-ollama providers. */
async function handleProvisionOllamaModelJob(
  db: Database,
  payload: OllamaProvisionJobPayload,
): Promise<OllamaProvisionResult> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
    columns: { id: true, name: true, model: true, modelfile: true, envVars: true },
  });
  if (!provider) {
    return { ok: false, providerId: payload.providerId, error: 'provider not found' };
  }
  if (provider.name !== 'ollama') {
    return { ok: true, providerId: payload.providerId };
  }
  return provisionOllamaProvider(db, provider);
}

/** How long to defer a job that hit its task's agent cap before BullMQ retries it. */
const TASK_AGENT_CAP_DEFER_MS = 4000;

/** Per-task agent cap, enforced at job pickup. Counts the task's currently-running
 *  CLI invocations (started, not ended/superseded) from the DB; if at/over the
 *  admin MAX_PARALLEL_AGENTS_PER_TASK cap, move this job back to delayed so its
 *  slot frees for other tasks/users, then throw DelayedError so BullMQ treats it
 *  as deferred (not failed) and redelivers it later. Fail-open: any error, a
 *  missing worker token, or the step_summary helper lets the job run rather than
 *  block. The DB count is authoritative (no counter to leak); ended_at is set on
 *  every terminal outcome, so a finished agent stops counting against the cap. */
async function enforceTaskAgentCap(
  db: Database,
  payload: CliExecJobPayload,
  job: Job<CliExecQueuePayload>,
  token: string | undefined,
): Promise<void> {
  if (payload.purpose === 'step_summary' || !token) return;
  let cap: number;
  try {
    cap = Math.max(
      1,
      Math.floor(await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, 5)),
    );
  } catch {
    return; // config unavailable — don't block the job
  }
  let running: number;
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.cliInvocations)
      .where(
        and(
          eq(schema.cliInvocations.taskId, payload.taskId),
          isNotNull(schema.cliInvocations.startedAt),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    running = rows[0]?.n ?? 0;
  } catch (err) {
    log.warn({ err, taskId: payload.taskId }, 'per-task cap count failed; allowing job');
    return;
  }
  if (running < cap) return;
  try {
    await job.moveToDelayed(Date.now() + TASK_AGENT_CAP_DEFER_MS, token);
  } catch (err) {
    log.warn({ err, taskId: payload.taskId }, 'per-task cap defer failed; allowing job');
    return;
  }
  log.debug(
    { taskId: payload.taskId, invocationId: payload.invocationId, running, cap },
    'per-task agent cap reached; deferring invocation',
  );
  throw new DelayedError();
}

export async function startCliExecWorker(
  deps: CliExecDeps = defaultDeps,
): Promise<
  Worker<
    CliExecQueuePayload,
    | CliProbeResult
    | SandboxImageBuildResult
    | RefreshCliVersionsJobResult
    | CliLoginCreateResult
    | OllamaProvisionResult
    | void
  >
> {
  // Max parallel agent/CLI invocations. A positive MAX_PARALLEL_AGENTS pins it; at 0 it is
  // sized from the host budget the runtime pool is NOT holding. Falls back to the fixed
  // default when config isn't initialized (e.g. focused smoke tests).
  let concurrency = STATIC_PARALLEL_AGENTS;
  try {
    concurrency = clampParallelCap(await resolveAgentConcurrency(STATIC_PARALLEL_AGENTS));
  } catch {
    /* config not initialized — keep the default */
  }
  const worker = new Worker<
    CliExecQueuePayload,
    | CliProbeResult
    | SandboxImageBuildResult
    | RefreshCliVersionsJobResult
    | CliLoginCreateResult
    | CliSignOutJobResult
    | OllamaProvisionResult
    | void
  >(
    QUEUE_NAMES.CLI_EXEC,
    async (job: Job<CliExecQueuePayload>, token?: string) => {
      const db = getDb();
      if (job.name === CLI_EXEC_JOB_NAMES.INVOKE) {
        const payload = job.data as CliExecJobPayload;
        // Per-task cap: if this task already runs its max parallel agents, defer
        // the job (freeing the slot for others) and let BullMQ redeliver it.
        // Throws DelayedError on defer; no-op when under the cap.
        await enforceTaskAgentCap(db, payload, job, token);
        await handleCliExecJob(db, payload, deps);
        return;
      }
      if (job.name === CLI_EXEC_JOB_NAMES.PROBE) {
        return handleProbeJob(db, job.data as CliProbeJobPayload);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE) {
        return handleBuildSandboxImageJob(db, job.data as SandboxImageBuildJobPayload);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS) {
        return handleRefreshCliVersionsJob(db);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.LOGIN_CREATE) {
        return handleLoginCreateJob(db, job.data as CliLoginCreateJobPayload);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.SIGN_OUT) {
        return handleSignOutJob(db, job.data as CliSignOutJobPayload);
      }
      if (job.name === CLI_EXEC_JOB_NAMES.PROVISION_OLLAMA_MODEL) {
        return handleProvisionOllamaModelJob(db, job.data as OllamaProvisionJobPayload);
      }
      throw new Error(`unknown cli-exec job ${job.name}`);
    },
    {
      connection: getBullRedis(),
      concurrency,
      // CLI execs run for minutes; default 30s lock would expire and cause
      // BullMQ to redeliver the job to a new worker pid (after a tsx watch
      // restart, SIGKILL, etc.), spawning a duplicate sandbox container for
      // the same job. 30 min covers thinking time + restart gaps.
      lockDuration: 30 * 60 * 1000,
      // Default maxStalledCount=1 marks a job UnrecoverableError after a
      // single stall event — too aggressive when worker restarts during
      // tsx-watch dev. Allow many redeliveries; the boot reaper kills any
      // orphan container so each redelivery starts fresh.
      maxStalledCount: 10,
    },
  );

  worker.on('completed', (job) => {
    log.info({ jobId: job.id, name: job.name }, 'cli-exec job completed');
  });
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, name: job?.name, err }, 'cli-exec job failed');
  });

  // Live-retune concurrency (BullMQ v5 honors the runtime setter; lowering lets in-flight jobs
  // drain). The boot read above is the always-correct fallback on restart.
  const applyConcurrency = async (): Promise<void> => {
    let next: number;
    try {
      next = clampParallelCap(await resolveAgentConcurrency(STATIC_PARALLEL_AGENTS));
    } catch (err) {
      log.warn({ err }, 'cli-exec concurrency resolve failed; keeping the current value');
      return;
    }
    if (next === (worker as { concurrency: number }).concurrency) return;
    try {
      (worker as { concurrency: number }).concurrency = next;
      log.info({ concurrency: next }, 'cli-exec concurrency retuned');
    } catch (err) {
      log.warn({ err, next }, 'cli-exec concurrency retune failed (restart to apply)');
    }
  };

  // Poll: when auto-sized, the number moves with runtime occupancy, and a runner booting or
  // being reaped publishes nothing. Cheap (one docker ps + cached config) and a no-op while
  // MAX_PARALLEL_AGENTS is pinned.
  const poll = setInterval(() => void applyConcurrency(), AGENT_CONCURRENCY_POLL_MS);
  if (poll.unref) poll.unref();
  worker.on('closing', () => clearInterval(poll));

  // Push: an admin changing MAX_PARALLEL_AGENTS (either channel also carries weight/budget
  // changes) retunes immediately instead of waiting out the poll. The published value is
  // ignored — resolveAgentConcurrency re-reads it, because 0 means "size it yourself".
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const sub = createRedisConnection(redisUrl);
    sub.on('message', () => {
      configService.clearCache();
      void applyConcurrency();
    });
    Promise.all([
      sub.subscribe(CONFIG_CONCURRENCY_CHANNEL),
      sub.subscribe(CONFIG_RUNTIME_LIMITS_CHANNEL),
    ]).catch((err) => {
      log.warn({ err }, 'cli-exec concurrency subscribe failed');
    });
    worker.on('closing', () => {
      void sub.quit().catch(() => {});
    });
  }

  log.info({ concurrency }, 'cli-exec worker started');
  return worker;
}
