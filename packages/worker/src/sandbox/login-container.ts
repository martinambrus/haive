import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import type { CliCommandSpec, CliProviderRecord } from '../cli-adapters/types.js';
import { resolveCliAuthMounts } from './cli-auth-volume.js';
import { SANDBOX_USER, SANDBOX_WORKDIR } from './sandbox-runner.js';

const log = logger.child({ module: 'login-container' });

/** Env keys injected into every login container to force CLIs into their
 *  device-code / paste-token flow instead of trying to launch a host browser
 *  (which cannot reach the container's loopback from outside). */
const HEADLESS_AUTH_ENV: Record<string, string> = {
  BROWSER: '/bin/false',
  DISPLAY: '',
  SSH_TTY: '/dev/pts/0',
  SSH_CONNECTION: '127.0.0.1 22 127.0.0.1 22',
  // Consumed by /usr/local/bin/restore-claude.sh — resets ~/.claude.json to
  // the onboarding-complete seed and removes stale .credentials.json before
  // claude setup-token starts, so the welcome/theme picker is skipped and
  // the OAuth exchange is deterministic.
  HAIVE_LOGIN_CONTAINER: '1',
};

export interface CreateLoginContainerOpts {
  provider: CliProviderRecord;
  commandSpec: CliCommandSpec;
  docker: Docker;
}

export interface CreateLoginContainerResult {
  containerRowId: string;
  dockerContainer: Docker.Container;
  dockerContainerId: string;
}

/** Create (but do not start) a login container using the supplied command spec.
 *  Persists a `containers` row with purpose='cli_login'. Caller is responsible
 *  for attaching, starting, and removing the container. */
export async function createSandboxLoginContainer(
  db: Database,
  opts: CreateLoginContainerOpts,
): Promise<CreateLoginContainerResult> {
  const { provider, commandSpec, docker } = opts;
  if (!cliAdapterRegistry.has(provider.name)) {
    throw new Error(`no adapter registered for ${provider.name}`);
  }
  if (provider.sandboxImageBuildStatus !== 'ready' || !provider.sandboxImageTag) {
    throw new Error(`sandbox image not ready (status=${provider.sandboxImageBuildStatus})`);
  }

  const volumeMounts = resolveCliAuthMounts(provider.userId, provider.name, {
    writable: true,
  });
  const binds = volumeMounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`);
  log.info(
    { providerId: provider.id, volumeMounts: volumeMounts.length },
    'login container mounts resolved',
  );

  const mergedEnv: Record<string, string> = { ...HEADLESS_AUTH_ENV, ...commandSpec.env };
  const envArr = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);

  const dockerContainer = await docker.createContainer({
    Image: provider.sandboxImageTag,
    Cmd: [commandSpec.command, ...commandSpec.args],
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

  try {
    const inserted = await db
      .insert(schema.containers)
      .values({
        taskId: null,
        purpose: 'cli_login',
        cliProviderId: provider.id,
        runtime: 'dockerode',
        dockerContainerId: dockerContainer.id,
        name: `haive-login-${provider.name}-${provider.id.slice(0, 8)}`,
        status: 'running',
        envVars: mergedEnv,
      })
      .returning({ id: schema.containers.id });
    const row = inserted[0];
    if (!row) {
      await dockerContainer.remove({ force: true }).catch(() => undefined);
      throw new Error('failed to persist container row');
    }
    return {
      containerRowId: row.id,
      dockerContainer,
      dockerContainerId: dockerContainer.id,
    };
  } catch (err) {
    await dockerContainer.remove({ force: true }).catch(() => undefined);
    log.error({ err, providerId: provider.id }, 'failed to persist login container row');
    throw err;
  }
}

/** Remove a login container's docker resource and mark the row destroyed. */
export async function teardownLoginContainer(
  db: Database,
  containerRowId: string,
  docker: Docker,
): Promise<void> {
  const row = await db.query.containers.findFirst({
    where: eq(schema.containers.id, containerRowId),
  });
  if (!row) return;
  if (row.dockerContainerId) {
    try {
      await docker.getContainer(row.dockerContainerId).remove({ force: true });
    } catch (err) {
      log.warn({ err, dockerContainerId: row.dockerContainerId }, 'docker remove failed');
    }
  }
  await db
    .update(schema.containers)
    .set({ status: 'destroyed', destroyedAt: new Date() })
    .where(eq(schema.containers.id, containerRowId));
}
