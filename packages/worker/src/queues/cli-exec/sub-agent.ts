import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { type CliExecJobPayload, type CliProviderName } from '@haive/shared';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import type { SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
import type { SubAgentInvocation } from '../../cli-adapters/types.js';
import { runSequentialSubAgent, type SubAgentRunResult } from '../../cli-executor/index.js';
import { assembleNativePrompt } from '../../sub-agent-emulator/native-mode.js';
import { type CliExecDeps, type ExecutionOutcome } from './_shared.js';
import { createSandboxSpawner, executeCliSpec } from './exec-core.js';
import {
  resolveAuthMounts,
  resolveEffectiveEgressDomains,
  resolveMcpExtraFiles,
} from './resolvers.js';
import { resolveSandboxImageTag } from './images.js';
import { makeUsageSnapshotPersister } from './running-usage.js';

export async function executeSubAgentNative(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
  secrets: Record<string, string>,
  repoMount: DockerVolumeMount | null,
  sandboxWorkdir: string,
  maskFiles: SandboxExtraFile[],
): Promise<ExecutionOutcome> {
  if (!payload.cliProviderId) {
    throw new Error('subagent_native requires cliProviderId');
  }
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.cliProviderId),
  });
  if (!provider) {
    throw new Error(`cli provider ${payload.cliProviderId} not found`);
  }
  const adapter = cliAdapterRegistry.get(provider.name);

  const invocation = payload.spec as SubAgentInvocation;
  if (invocation.mode !== 'native') {
    throw new Error(`subagent_native expected native invocation, got ${invocation.mode}`);
  }

  const prompt = assembleNativePrompt(invocation);
  const spec = adapter.buildCliInvocation(provider, prompt, {
    cwd: sandboxWorkdir,
    extraEnv: secrets,
    effortLevel: payload.effortLevel,
  });
  const sandboxImage = await resolveSandboxImageTag(db, payload.taskId, provider);
  const mcp = await resolveMcpExtraFiles(
    db,
    payload.taskId,
    provider.name as CliProviderName,
    sandboxWorkdir,
  );
  const authMounts = await resolveAuthMounts(db, provider, payload.taskId);
  return executeCliSpec(
    spec,
    deps,
    payload.timeoutMs,
    secrets,
    provider.wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    provider.networkPolicy,
    resolveEffectiveEgressDomains(provider),
    [...mcp.files, ...maskFiles],
    authMounts,
    undefined,
    payload.taskId ?? null,
    payload.invocationId ?? null,
    mcp.extraArgs,
    makeUsageSnapshotPersister(db, payload.invocationId),
  );
}

export async function executeSubAgentSequential(
  db: Database,
  payload: CliExecJobPayload,
  secrets: Record<string, string>,
  repoMount: DockerVolumeMount | null,
  sandboxWorkdir: string,
  maskFiles: SandboxExtraFile[],
): Promise<ExecutionOutcome> {
  if (!payload.cliProviderId) {
    throw new Error('subagent_sequential requires cliProviderId');
  }
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.cliProviderId),
  });
  if (!provider) {
    throw new Error(`cli provider ${payload.cliProviderId} not found`);
  }
  const adapter = cliAdapterRegistry.get(provider.name);

  const invocation = payload.spec as SubAgentInvocation;
  if (invocation.mode !== 'sequential') {
    throw new Error(`subagent_sequential expected sequential invocation, got ${invocation.mode}`);
  }

  const sandboxImage = await resolveSandboxImageTag(db, payload.taskId, provider);
  const mcp = await resolveMcpExtraFiles(
    db,
    payload.taskId,
    provider.name as CliProviderName,
    sandboxWorkdir,
  );
  const authMounts = await resolveAuthMounts(db, provider, payload.taskId);
  const spawner = createSandboxSpawner(
    provider.wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    provider.networkPolicy,
    resolveEffectiveEgressDomains(provider),
    [...mcp.files, ...maskFiles],
    authMounts,
    payload.taskId ?? null,
    payload.invocationId ?? null,
    mcp.extraArgs,
  );
  const result: SubAgentRunResult = await runSequentialSubAgent(
    invocation,
    (prompt) =>
      adapter.buildCliInvocation(provider, prompt, {
        cwd: sandboxWorkdir,
        extraEnv: secrets,
        effortLevel: payload.effortLevel,
      }),
    spawner,
    { timeoutMs: payload.timeoutMs },
  );

  const failed = result.exitCode !== 0;
  return {
    exitCode: result.exitCode,
    rawOutput: JSON.stringify(result.trace),
    parsedOutput: { collected: result.collected, synthesis: result.synthesis },
    errorMessage: failed ? describeFailedSubAgent(result) : null,
    tokenUsage: result.tokenUsage,
  };
}

function describeFailedSubAgent(result: SubAgentRunResult): string {
  const failedEntry = result.trace.find((t) => (t.exitCode ?? 0) !== 0 || t.error);
  if (!failedEntry) return 'sub-agent script exited non-zero';
  return `sub-agent step ${failedEntry.id} failed: ${failedEntry.error ?? failedEntry.stderr.slice(0, 500)}`;
}
