import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  subpath?: string;
}

export interface DockerRunOpts {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  mounts?: DockerVolumeMount[];
  workdir?: string;
  entrypoint?: string | null;
  network?: string;
  /** Run container as this user (e.g. 'node', '1000:1000'). Omit for image default. */
  user?: string;
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

export interface DockerInspectResult {
  exists: boolean;
  imageId: string | null;
}

export interface DockerRemoveResult {
  ok: boolean;
  stderr: string;
  error?: string;
}

export interface DockerVolumeOpResult {
  ok: boolean;
  stderr: string;
  error?: string;
}

export interface DockerRunner {
  build(opts: DockerBuildOpts): Promise<DockerBuildResult>;
  run(opts: DockerRunOpts): Promise<DockerRunResult>;
  inspect(tag: string): Promise<DockerInspectResult>;
  remove(ref: string): Promise<DockerRemoveResult>;
  volumeCreate(name: string): Promise<DockerVolumeOpResult>;
  volumeExists(name: string): Promise<boolean>;
  volumeRemove(name: string): Promise<DockerVolumeOpResult>;
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

    // Stateful UTF-8 decoders preserve multi-byte sequences across chunk boundaries.
    // Plain Buffer.toString('utf8') on partial chunks emits U+FFFD replacement chars
    // which corrupt downstream JSON parsing of stream-json events.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    // Optional raw-byte capture for debugging stream-json corruption. Writes
    // unprocessed Buffer chunks to <DEBUG_CLI_STREAM_DIR>/<uuid>.bin so we can
    // inspect what claude binary actually wrote vs. what we stored.
    let debugStream: WriteStream | null = null;
    const debugDir = process.env.DEBUG_CLI_STREAM_DIR;
    if (debugDir && command === 'docker' && args[0] === 'run') {
      try {
        mkdirSync(debugDir, { recursive: true });
        const path = join(debugDir, `${Date.now()}_${randomUUID()}.bin`);
        debugStream = createWriteStream(path);
        debugStream.write(`# command: ${command} ${args.slice(0, 4).join(' ')}\n`);
      } catch {
        debugStream = null;
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (debugStream) debugStream.write(chunk);
      const text = stdoutDecoder.write(chunk);
      if (text) {
        stdout += text;
        opts.onStdoutChunk?.(text);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text) {
        stderr += text;
        opts.onStderrChunk?.(text);
      }
    });
    child.on('error', (err) => {
      errorMessage = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', abortHandler);
      const tail = stdoutDecoder.end();
      if (tail) {
        stdout += tail;
        opts.onStdoutChunk?.(tail);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) {
        stderr += stderrTail;
        opts.onStderrChunk?.(stderrTail);
      }
      if (debugStream) debugStream.end();
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

  async inspect(tag) {
    const result = await spawnAndCollect(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      { timeoutMs: 15_000 },
    );
    if (result.exitCode === 0) {
      return { exists: true, imageId: result.stdout.trim() || null };
    }
    return { exists: false, imageId: null };
  },

  async remove(ref) {
    const result = await spawnAndCollect('docker', ['image', 'rm', '--force', ref], {
      timeoutMs: 30_000,
    });
    return {
      ok: result.exitCode === 0,
      stderr: result.stderr,
      error: result.error,
    };
  },

  async run(opts) {
    const args = ['run', '--rm'];
    if (opts.user) args.push('--user', opts.user);
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
        if (m.subpath) {
          const parts = [
            'type=volume',
            `source=${m.source}`,
            `destination=${m.target}`,
            `volume-subpath=${m.subpath}`,
          ];
          if (m.readOnly) parts.push('readonly');
          args.push('--mount', parts.join(','));
        } else {
          const suffix = m.readOnly ? ':ro' : '';
          args.push('-v', `${m.source}:${m.target}${suffix}`);
        }
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

  async volumeCreate(name) {
    const result = await spawnAndCollect('docker', ['volume', 'create', name], {
      timeoutMs: 15_000,
    });
    return { ok: result.exitCode === 0, stderr: result.stderr, error: result.error };
  },

  async volumeExists(name) {
    const result = await spawnAndCollect('docker', ['volume', 'inspect', name], {
      timeoutMs: 15_000,
    });
    return result.exitCode === 0;
  },

  async volumeRemove(name) {
    const result = await spawnAndCollect('docker', ['volume', 'rm', '--force', name], {
      timeoutMs: 30_000,
    });
    return { ok: result.exitCode === 0, stderr: result.stderr, error: result.error };
  },
};
