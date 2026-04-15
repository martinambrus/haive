import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { logger } from '@haive/shared';
import {
  defaultDockerRunner,
  type DockerRunner,
  type DockerRunResult,
  type DockerVolumeMount,
} from './docker-runner.js';

const log = logger.child({ module: 'sandbox-runner' });

const DEFAULT_SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const DEFAULT_WRAPPER_VOLUME = process.env.SANDBOX_WRAPPER_HOST_VOLUME ?? 'haive_wrappers';
const DEFAULT_WRAPPER_WORKER_PATH = process.env.SANDBOX_WRAPPER_WORKER_PATH ?? '/var/lib/haive/wrappers';
const DEFAULT_WRAPPER_SANDBOX_PATH = '/haive/wrappers';
const DEFAULT_WORKDIR = '/haive/workdir';

export interface SandboxRunSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  wrapperContent?: string | null;
  timeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface SandboxRunnerOptions {
  image?: string;
  wrapperVolumeName?: string;
  wrapperWorkerPath?: string;
  wrapperSandboxPath?: string;
  workdir?: string;
  docker?: DockerRunner;
  extraMounts?: DockerVolumeMount[];
}

export interface SandboxRunResult extends DockerRunResult {
  resolvedCommand: string;
  wrapperId: string | null;
}

/**
 * Execute a command inside the haive-cli-sandbox image.
 *
 * If `wrapperContent` is provided, the content is materialized to a
 * unique path on the shared haive_wrappers volume, chmod +x, and used as
 * the invoked executable in place of spec.command. The wrapper file is
 * cleaned up after the run regardless of exit code.
 *
 * Mounts only the wrapper volume (read-only); no worker fs leaks into
 * the sandbox. Host Docker daemon resolves the named volume.
 */
export async function runInSandbox(
  spec: SandboxRunSpec,
  options: SandboxRunnerOptions = {},
): Promise<SandboxRunResult> {
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const volumeName = options.wrapperVolumeName ?? DEFAULT_WRAPPER_VOLUME;
  const wrapperWorkerRoot = options.wrapperWorkerPath ?? DEFAULT_WRAPPER_WORKER_PATH;
  const wrapperSandboxRoot = options.wrapperSandboxPath ?? DEFAULT_WRAPPER_SANDBOX_PATH;
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const runner = options.docker ?? defaultDockerRunner;

  const mounts: DockerVolumeMount[] = [
    { source: volumeName, target: wrapperSandboxRoot, readOnly: true },
    ...(options.extraMounts ?? []),
  ];

  let wrapperId: string | null = null;
  let wrapperWorkerPath: string | null = null;
  let resolvedCommand = spec.command;

  if (spec.wrapperContent && spec.wrapperContent.trim().length > 0) {
    wrapperId = randomUUID();
    const fileName = 'wrapper.sh';
    wrapperWorkerPath = join(wrapperWorkerRoot, wrapperId, fileName);
    const wrapperSandboxPath = `${wrapperSandboxRoot}/${wrapperId}/${fileName}`;
    try {
      await mkdir(dirname(wrapperWorkerPath), { recursive: true });
      await writeFile(wrapperWorkerPath, normalizeWrapperContent(spec.wrapperContent), 'utf8');
      await chmod(wrapperWorkerPath, 0o755);
      resolvedCommand = wrapperSandboxPath;
    } catch (err) {
      log.warn({ err, wrapperWorkerPath }, 'failed to materialize wrapper');
      throw err;
    }
  }

  try {
    const result = await runner.run({
      image,
      cmd: [resolvedCommand, ...spec.args],
      env: spec.env,
      mounts,
      workdir,
      timeoutMs: spec.timeoutMs,
      onStdoutChunk: spec.onStdoutChunk,
      onStderrChunk: spec.onStderrChunk,
      signal: spec.signal,
    });
    return { ...result, resolvedCommand, wrapperId };
  } finally {
    if (wrapperWorkerPath) {
      const wrapperDir = dirname(wrapperWorkerPath);
      rm(wrapperDir, { recursive: true, force: true }).catch((err: unknown) => {
        log.warn({ err, wrapperDir }, 'failed to cleanup wrapper dir');
      });
    }
  }
}

function normalizeWrapperContent(content: string): string {
  const withShebang = content.startsWith('#!') ? content : `#!/bin/bash\n${content}`;
  return withShebang.endsWith('\n') ? withShebang : `${withShebang}\n`;
}
