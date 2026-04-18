import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type CliLoginStartJobPayload, type CliLoginStartResult } from '@haive/shared';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import {
  buildLoginCommand,
  CliLoginUnsupportedError,
  isCliLoginSupported,
} from '../cli-adapters/login-command.js';
import { resolveCliAuthMounts } from './cli-auth-volume.js';
import { resolveCliAuthHostBinds } from './cli-auth-host.js';
import { SANDBOX_USER, SANDBOX_WORKDIR } from './sandbox-runner.js';

const log = logger.child({ module: 'login-container' });

export interface StartLoginContainerDeps {
  docker?: Docker;
}

export async function startLoginContainer(
  db: Database,
  payload: CliLoginStartJobPayload,
  deps: StartLoginContainerDeps = {},
): Promise<CliLoginStartResult> {
  const docker = deps.docker ?? new Docker();

  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, payload.providerId),
  });
  if (!provider) {
    return { ok: false, error: 'provider not found' };
  }
  if (provider.userId !== payload.userId) {
    return { ok: false, error: 'provider not owned by user' };
  }
  if (!isCliLoginSupported(provider.name)) {
    return { ok: false, error: `interactive login not supported for ${provider.name}` };
  }
  if (provider.sandboxImageBuildStatus !== 'ready' || !provider.sandboxImageTag) {
    return {
      ok: false,
      error: `sandbox image not ready (status=${provider.sandboxImageBuildStatus})`,
    };
  }
  if (!cliAdapterRegistry.has(provider.name)) {
    return { ok: false, error: `no adapter registered for ${provider.name}` };
  }

  const adapter = cliAdapterRegistry.get(provider.name);
  const executable =
    provider.wrapperPath?.trim() || provider.executablePath?.trim() || adapter.defaultExecutable;

  let loginSpec;
  try {
    loginSpec = buildLoginCommand(provider, executable);
  } catch (err) {
    if (err instanceof CliLoginUnsupportedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  const hostBinds = await resolveCliAuthHostBinds(provider.name, { writable: true });
  const hostBoundTargets = new Set(hostBinds.map((b) => b.containerPath));
  const volumeMounts = resolveCliAuthMounts(provider.userId, provider.name, {
    writable: true,
  }).filter((m) => !hostBoundTargets.has(m.target));
  const binds = [
    ...hostBinds.map((b) => `${b.hostPath}:${b.containerPath}${b.readOnly ? ':ro' : ''}`),
    ...volumeMounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
  ];
  log.info(
    { providerId: provider.id, hostBinds: hostBinds.length, volumeMounts: volumeMounts.length },
    'login container mounts resolved',
  );

  const envArr = Object.entries(loginSpec.env).map(([k, v]) => `${k}=${v}`);

  let container;
  try {
    container = await docker.createContainer({
      Image: provider.sandboxImageTag,
      Cmd: [loginSpec.command, ...loginSpec.args],
      Env: envArr,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: SANDBOX_WORKDIR,
      User: SANDBOX_USER,
      HostConfig: {
        AutoRemove: false,
        Binds: binds,
      },
    });
    await container.start();
  } catch (err) {
    log.error({ err, providerId: provider.id }, 'failed to start login container');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const inserted = await db
      .insert(schema.containers)
      .values({
        taskId: null,
        purpose: 'cli_login',
        cliProviderId: provider.id,
        runtime: 'dockerode',
        dockerContainerId: container.id,
        name: `haive-login-${provider.name}-${provider.id.slice(0, 8)}`,
        status: 'running',
        envVars: loginSpec.env,
      })
      .returning({ id: schema.containers.id });
    const row = inserted[0];
    if (!row) {
      await container.remove({ force: true }).catch(() => undefined);
      return { ok: false, error: 'failed to persist container row' };
    }
    return {
      ok: true,
      containerId: row.id,
      dockerContainerId: container.id,
    };
  } catch (err) {
    await container.remove({ force: true }).catch(() => undefined);
    log.error({ err, providerId: provider.id }, 'failed to persist login container row');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface StopLoginContainerResult {
  ok: boolean;
  error?: string;
}

export async function stopLoginContainer(
  db: Database,
  containerRowId: string,
  deps: StartLoginContainerDeps = {},
): Promise<StopLoginContainerResult> {
  const docker = deps.docker ?? new Docker();
  const row = await db.query.containers.findFirst({
    where: eq(schema.containers.id, containerRowId),
  });
  if (!row) return { ok: false, error: 'container row not found' };
  if (row.purpose !== 'cli_login') {
    return { ok: false, error: 'container is not a cli_login container' };
  }
  if (row.dockerContainerId) {
    try {
      const c = docker.getContainer(row.dockerContainerId);
      await c.remove({ force: true });
    } catch (err) {
      log.warn({ err, dockerContainerId: row.dockerContainerId }, 'docker remove failed');
    }
  }
  await db
    .update(schema.containers)
    .set({ status: 'destroyed', destroyedAt: new Date() })
    .where(eq(schema.containers.id, containerRowId));
  return { ok: true };
}
