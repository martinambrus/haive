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
  /** Extra networks to attach AFTER create, before start (docker run takes only
   *  one --network). Triggers a create -> network connect -> start -a flow.
   *  Used to give the sandbox an internal api-only NIC regardless of its policy
   *  network. Empty/undefined keeps the plain `docker run` path. */
  connectNetworks?: string[];
  /** Run container as this user (e.g. 'node', '1000:1000'). Omit for image default. */
  user?: string;
  /** Docker labels to attach. Used so cancel can find and kill containers by task id. */
  labels?: Record<string, string>;
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
    // --progress=plain emits flat newline-delimited output. Without it docker
    // CLI defaults to a TTY-aware progress writer that occasionally stalls
    // when piped into a non-TTY child stdio (the worker spawn case): verbose
    // dpkg output (e.g. apt-installing nano on a slow mirror) overflows the
    // pipe and the build hangs with no exit. Plain mode avoids the issue.
    const args = ['build', '--progress=plain', '-t', opts.tag];
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
    const containerName = `haive-cli-${randomUUID()}`;
    const flagArgs: string[] = [];
    if (opts.labels) {
      for (const [k, v] of Object.entries(opts.labels)) {
        flagArgs.push('--label', `${k}=${v}`);
      }
    }
    if (opts.user) flagArgs.push('--user', opts.user);
    if (opts.workdir) flagArgs.push('-w', opts.workdir);
    if (opts.network) flagArgs.push('--network', opts.network);
    if (opts.entrypoint !== undefined) {
      flagArgs.push('--entrypoint', opts.entrypoint ?? '');
    }
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        flagArgs.push('-e', `${key}=${value}`);
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
          flagArgs.push('--mount', parts.join(','));
        } else {
          const suffix = m.readOnly ? ':ro' : '';
          flagArgs.push('-v', `${m.source}:${m.target}${suffix}`);
        }
      }
    }

    // SIGKILL/SIGTERM on the docker CLI client doesn't propagate to the
    // dockerd-side container; --rm only fires when the container itself exits.
    // Force-remove by name when our wrapper killed the client (timedOut) or the
    // run returned no exit code (signal abort), or a setup step failed.
    const forceRemove = () =>
      spawnAndCollect('docker', ['rm', '-f', containerName], { timeoutMs: 15_000 }).catch(
        () => undefined,
      );

    // Plain path: a single `docker run`.
    if (!opts.connectNetworks?.length) {
      const result = await spawnAndCollect(
        'docker',
        ['run', '--rm', '--name', containerName, ...flagArgs, opts.image, ...opts.cmd],
        {
          timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          onStdoutChunk: opts.onStdoutChunk,
          onStderrChunk: opts.onStderrChunk,
          signal: opts.signal,
        },
      );
      if (result.timedOut || result.exitCode === null) await forceRemove();
      return result;
    }

    // Multi-network path: `docker run` takes only one --network, so a second NIC
    // (the internal api-only network) requires create -> network connect -> start
    // (mirrors the squid gateway in egress-gateway.ts).
    const created = await spawnAndCollect(
      'docker',
      ['create', '--rm', '--name', containerName, ...flagArgs, opts.image, ...opts.cmd],
      { timeoutMs: 30_000 },
    );
    if (created.exitCode !== 0) {
      await forceRemove();
      return created;
    }
    for (const net of opts.connectNetworks) {
      const connected = await spawnAndCollect(
        'docker',
        ['network', 'connect', net, containerName],
        { timeoutMs: 15_000 },
      );
      if (connected.exitCode !== 0) {
        await forceRemove();
        return connected;
      }
    }
    const result = await spawnAndCollect('docker', ['start', '--attach', containerName], {
      timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      signal: opts.signal,
    });
    if (result.timedOut || result.exitCode === null) await forceRemove();
    return result;
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
