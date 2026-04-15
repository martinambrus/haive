import { spawn } from 'node:child_process';

export interface DockerBuildOpts {
  contextDir: string;
  dockerfilePath?: string;
  tag: string;
  buildArgs?: Record<string, string>;
  timeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface DockerBuildResult {
  exitCode: number | null;
  imageTag: string;
  imageId: string | null;
  durationMs: number;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface DockerVolumeMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface DockerRunOpts {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  mounts?: DockerVolumeMount[];
  workdir?: string;
  entrypoint?: string | null;
  network?: string;
  timeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface DockerRunner {
  build(opts: DockerBuildOpts): Promise<DockerBuildResult>;
  run(opts: DockerRunOpts): Promise<DockerRunResult>;
}

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 1000;

async function spawnAndCollect(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
    signal?: AbortSignal;
    env?: Record<string, string>;
  },
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let errorMessage: string | undefined;

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const abortHandler = (): void => {
      child.kill('SIGTERM');
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      opts.onStdoutChunk?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      opts.onStderrChunk?.(text);
    });
    child.on('error', (err) => {
      errorMessage = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', abortHandler);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        error: errorMessage,
      });
    });
  });
}

export const defaultDockerRunner: DockerRunner = {
  async build(opts) {
    const args = ['build', '-t', opts.tag];
    if (opts.dockerfilePath) {
      args.push('-f', opts.dockerfilePath);
    }
    if (opts.buildArgs) {
      for (const [key, value] of Object.entries(opts.buildArgs)) {
        args.push('--build-arg', `${key}=${value}`);
      }
    }
    args.push(opts.contextDir);
    const result = await spawnAndCollect('docker', args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      signal: opts.signal,
    });
    let imageId: string | null = null;
    if (result.exitCode === 0) {
      const inspect = await spawnAndCollect(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', opts.tag],
        { timeoutMs: 15_000 },
      );
      if (inspect.exitCode === 0) {
        imageId = inspect.stdout.trim() || null;
      }
    }
    return {
      exitCode: result.exitCode,
      imageTag: opts.tag,
      imageId,
      durationMs: result.durationMs,
      stderr: result.stderr,
      timedOut: result.timedOut,
      error: result.error,
    };
  },

  async run(opts) {
    const args = ['run', '--rm'];
    if (opts.workdir) args.push('-w', opts.workdir);
    if (opts.network) args.push('--network', opts.network);
    if (opts.entrypoint !== undefined) {
      args.push('--entrypoint', opts.entrypoint ?? '');
    }
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }
    if (opts.mounts) {
      for (const m of opts.mounts) {
        const suffix = m.readOnly ? ':ro' : '';
        args.push('-v', `${m.source}:${m.target}${suffix}`);
      }
    }
    args.push(opts.image, ...opts.cmd);
    return spawnAndCollect('docker', args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      signal: opts.signal,
    });
  },
};
