import { eq } from 'drizzle-orm';
import Docker from 'dockerode';
import { schema, type Database } from '@haive/database';
import {
  CLAUDE_MCP_CONFIG_PATH,
  buildMcpConfigForCli,
  type McpServerSpec,
} from '../sandbox/mcp-config.js';
import { resolveCliAuthMounts } from '../sandbox/cli-auth-volume.js';
import type { DockerVolumeMount } from '../sandbox/docker-runner.js';
import { resolveSandboxImageTag } from '../queues/cli-exec-queue.js';
import { SANDBOX_USER, SANDBOX_USER_HOME, SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { logger } from '@haive/shared';
import type { CliProviderRecord } from '../cli-adapters/types.js';

const log = logger.child({ module: 'terminal-container' });

/** Container name format: `haive-shell-{taskIdShort}-{providerIdShort}-{userIdShort}`.
 *  Truncated UUID slices keep the name under Docker's 64-char limit while
 *  remaining unique per (user, task, provider). The reaper greps for the
 *  `haive-shell-` prefix as a safety net for orphan cleanup. */
export function buildShellContainerName(
  userId: string,
  taskId: string,
  providerId: string,
): string {
  return `haive-shell-${taskId.slice(0, 8)}-${providerId.slice(0, 8)}-${userId.slice(0, 8)}`;
}

export interface EnsureShellContainerOpts {
  db: Database;
  docker: Docker;
  userId: string;
  taskId: string;
  providerId: string;
  /** Repo workdir mount (host path -> /haive/workdir or named-volume subpath
   *  for uploaded/cloned repos). Same DockerVolumeMount shape cli-exec-queue
   *  uses. May be null when a task has no associated repository (rare; we
   *  still spawn the container with no repo mount in that case). */
  repoMount: DockerVolumeMount | null;
  /** MCP servers configured for this user/task. Written into the container
   *  at /haive/mcp.json before the first attach so claude/zai pick it up. */
  mcpServers: McpServerSpec[];
}

export interface EnsureShellContainerResult {
  containerName: string;
  /** True when the container was just created. False when an existing
   *  container was reused (warm shell session within the grace window). */
  created: boolean;
  shell: 'bash' | 'sh';
  imageTag: string;
}

/** Ensure the per-(user, task, provider) shell container exists and is
 *  running. Idempotent: a second call within the session lifetime reuses
 *  the existing container so reconnects within the 2-minute grace window
 *  hit a warm shell with files preserved. */
export async function ensureShellContainer(
  opts: EnsureShellContainerOpts,
): Promise<EnsureShellContainerResult> {
  const { db, docker, userId, taskId, providerId, repoMount, mcpServers } = opts;

  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
  });
  if (!provider) throw new Error(`cli provider ${providerId} not found`);
  if (provider.userId !== userId) throw new Error('cli provider does not belong to user');

  // Resolve the same composed sandbox image cli-exec-queue uses so the
  // terminal sees the same toolchain (CLI binary + ripgrep + uv + env-template
  // packages) the orchestrator does. May trigger a build on first use.
  const imageTag = await resolveSandboxImageTag(db, taskId, {
    id: provider.id,
    userId: provider.userId,
    name: provider.name,
    cliVersion: provider.cliVersion,
    sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
  });
  if (!imageTag) {
    throw new Error(`no sandbox image available for provider ${provider.name}`);
  }

  const containerName = buildShellContainerName(userId, taskId, providerId);

  // Reuse an existing container when one is still alive — covers the
  // "navigate away then back within 2 min" path described in the plan.
  const existing = docker.getContainer(containerName);
  try {
    const inspect = await existing.inspect();
    if (inspect.State.Running) {
      const shell = await detectShell(docker, containerName);
      log.info({ containerName, taskId, providerId }, 'reusing existing shell container');
      return { containerName, created: false, shell, imageTag };
    }
    // Container exists but isn't running (likely killed by reaper between
    // inspect and now, or a crash). Remove it and recreate cleanly.
    await existing.remove({ force: true }).catch(() => undefined);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  const authMounts = resolveCliAuthMounts(
    {
      userId: provider.userId,
      providerId: provider.id,
      providerName: provider.name,
      isolateAuth: provider.isolateAuth,
    },
    { writable: true },
  );

  const binds: string[] = [
    ...authMounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
  ];
  // Subpath volume mounts use the modern Mounts API (Binds doesn't support
  // VolumeOptions.Subpath). Plain bind/named-volume mounts go via Binds for
  // parity with login-container.ts.
  const mounts: Array<{
    Type: 'volume' | 'bind';
    Source: string;
    Target: string;
    ReadOnly?: boolean;
    VolumeOptions?: { Subpath?: string };
  }> = [];
  if (repoMount) {
    if (repoMount.subpath) {
      mounts.push({
        Type: 'volume',
        Source: repoMount.source,
        Target: repoMount.target,
        ReadOnly: repoMount.readOnly ?? false,
        VolumeOptions: { Subpath: repoMount.subpath },
      });
    } else {
      const suffix = repoMount.readOnly ? ':ro' : '';
      binds.push(`${repoMount.source}:${repoMount.target}${suffix}`);
    }
  }

  // sleep infinity keeps PID 1 alive forever; attached sessions are
  // independent. PID 1 receives SIGTERM on `docker rm -f` so reaping is clean.
  // dockerode's HostConfig.Mounts type insists on NoCopy/Labels/DriverConfig
  // being required; the daemon accepts partial values, so cast to bypass the
  // overspec'd .d.ts.
  const hostConfig: Record<string, unknown> = {
    AutoRemove: false,
    Binds: binds,
  };
  if (mounts.length > 0) hostConfig.Mounts = mounts;
  let shellContainer: Docker.Container;
  try {
    shellContainer = await docker.createContainer({
      Image: imageTag,
      name: containerName,
      Cmd: ['sleep', 'infinity'],
      Tty: false,
      User: SANDBOX_USER,
      WorkingDir: SANDBOX_WORKDIR,
      Env: [`HOME=${SANDBOX_USER_HOME}`, 'TERM=xterm-256color'],
      HostConfig: hostConfig as never,
      Labels: {
        'haive.role': 'terminal-shell',
        'haive.user.id': userId,
        'haive.task.id': taskId,
        'haive.provider.id': providerId,
      },
    });
  } catch (err) {
    // Race: a sibling open (React StrictMode double-mount, or two tabs
    // hitting the same WS at once) won the create call. Fall back to the
    // existing container if it's running. We can't trust the inspect we did
    // above because the create happened in the gap.
    if (isConflictError(err)) {
      const sibling = await docker
        .getContainer(containerName)
        .inspect()
        .catch(() => null);
      if (sibling?.State?.Running) {
        const shell = await detectShell(docker, containerName);
        log.info(
          { containerName, taskId, providerId },
          'reusing concurrently-created shell container',
        );
        return { containerName, created: false, shell, imageTag };
      }
    }
    throw err;
  }
  await shellContainer.start().catch((err) => {
    if (!isAlreadyRunningError(err)) throw err;
  });

  // Chown the workdir mount to the sandbox user. The named haive_repos
  // volume can have root-owned files (clone/ingest steps run as root) which
  // makes the workdir unwritable for `node` (uid 1000) — surfaces as
  // "Permission denied" the first time a user tries to edit a file from the
  // shell. One-shot fix per fresh spawn; reused containers skip it.
  if (repoMount) {
    await chownWorkdir(docker, containerName, repoMount.target).catch((err) => {
      log.warn({ err, containerName }, 'workdir chown failed — writes may be denied');
    });
  }

  // Best-effort MCP injection: if it fails, the user can still use the
  // shell — only CLI commands that need MCP would be affected.
  await writeMcpConfigInto(docker, containerName, provider.name, mcpServers).catch((err) => {
    log.warn({ err, containerName }, 'failed to write mcp config into shell container');
  });

  const shell = await detectShell(docker, containerName);
  log.info({ containerName, taskId, providerId, imageTag, shell }, 'spawned shell container');
  return { containerName, created: true, shell, imageTag };
}

/** Force-remove the container if it exists. Safe to call concurrently with
 *  open exec sessions — Docker tears down child execs when the parent goes
 *  away. The reaper and task-end teardown both call this. */
export async function removeShellContainer(docker: Docker, containerName: string): Promise<void> {
  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

/** Probe the container for `bash`. Falls back to `sh` (always present in
 *  Alpine and Debian/Ubuntu base images). */
async function detectShell(docker: Docker, containerName: string): Promise<'bash' | 'sh'> {
  try {
    const probe = await docker.getContainer(containerName).exec({
      Cmd: ['sh', '-c', 'command -v bash >/dev/null 2>&1'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await probe.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
      // resume() drains the stream so 'end' fires — same gotcha as the MCP
      // writer above.
      stream.resume();
    });
    const info = await probe.inspect();
    return info.ExitCode === 0 ? 'bash' : 'sh';
  } catch {
    return 'sh';
  }
}

/** chown the entire workdir mount to the sandbox user as a one-shot root
 *  exec. Required because the haive_repos named volume often has root-owned
 *  files left behind by clone/ingest steps; the shell runs as `node` and
 *  would otherwise hit "Permission denied" on the first write. Idempotent. */
async function chownWorkdir(docker: Docker, containerName: string, target: string): Promise<void> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: ['chown', '-R', `${SANDBOX_USER}:${SANDBOX_USER}`, target],
    AttachStdout: true,
    AttachStderr: true,
    User: '0:0',
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
    stream.resume();
  });
  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error(`chown exited ${info.ExitCode}`);
  }
}

async function writeMcpConfigInto(
  docker: Docker,
  containerName: string,
  cliName: CliProviderRecord['name'],
  servers: McpServerSpec[],
): Promise<void> {
  const config = buildMcpConfigForCli(cliName, servers, SANDBOX_USER_HOME);
  const targetPath = config?.path ?? CLAUDE_MCP_CONFIG_PATH;
  const targetContent = config?.content ?? JSON.stringify({ mcpServers: {} }, null, 2);

  const container = docker.getContainer(containerName);
  const parent = parentDir(targetPath);
  if (parent && parent !== '/' && parent !== '') {
    const mk = await container.exec({
      Cmd: ['sh', '-c', `mkdir -p ${shellQuote(parent)}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await mk.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
      // Critical: resume() drains the stream so 'end' fires. Without it the
      // exec hangs forever — we hit this exact bug shipping the first cut.
      stream.resume();
    });
  }
  const write = await container.exec({
    Cmd: ['sh', '-c', `cat > ${shellQuote(targetPath)}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const wstream = await write.start({ hijack: true, stdin: true });
  wstream.write(targetContent);
  wstream.end();
  await new Promise<void>((resolve, reject) => {
    wstream.on('end', () => resolve());
    wstream.on('error', (err) => reject(err));
    wstream.resume();
  });
}

function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; reason?: string; message?: string };
  if (e.statusCode === 404) return true;
  if (typeof e.message === 'string' && /no such container/i.test(e.message)) return true;
  return false;
}

function isConflictError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode === 409) return true;
  if (typeof e.message === 'string' && /already in use/i.test(e.message)) return true;
  return false;
}

function isAlreadyRunningError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode === 304) return true;
  if (typeof e.message === 'string' && /already started/i.test(e.message)) return true;
  return false;
}
