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
  /** `'auth'` marks a CLI auth volume — a persistent volume holding the CLI's own credentials and
   *  config. Nothing may be bind-mounted at a path INSIDE one: Docker materialises the missing
   *  mount target in the volume as a root-owned stub that outlives the container, and the mount
   *  hides whatever the real file held. runInSandbox enforces it. Left unset for the repo mount,
   *  where nesting is how secret masking works. */
  kind?: 'auth';
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
  /** `--add-host` entries, each already formatted `hostname:ip`. Lets a sandbox dial the
   *  task's runtime by the hostname the app answers to, which is not in any DNS the
   *  container can see. Rides the shared flag list, so it applies to the plain `docker run`
   *  path and the create -> connect -> start path alike. */
  addHosts?: string[];
  /** Run container as this user (e.g. 'node', '1000:1000'). Omit for image default. */
  user?: string;
  /** Docker labels to attach. Used so cancel can find and kill containers by task id. */
  labels?: Record<string, string>;
  /** cgroup memory cap (MB): emits --memory + --memory-swap (equal, so swap is disabled
   *  and the sandbox OOM-kills instead of driving the host into swap). */
  memoryLimitMb?: number;
  /** cgroup CPU cap (millicores): emits --cpus. */
  cpuLimitMilli?: number;
  /** pid cap: emits --pids-limit. */
  pidsLimit?: number;
  timeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Interactive mode: open a writable stdin pipe (docker `-i`) instead of
   *  ignoring stdin, so a caller can stream input to the running container
   *  (mid-run steering). Default off keeps the one-shot `docker run` path. */
  interactive?: boolean;
  /** Written to the container's stdin immediately after start. Only used when
   *  interactive (e.g. the prompt as an NDJSON user-message). */
  stdinInitial?: string;
  /** The prompt, when it is too large to pass as an argument. Written once and
   *  the stream closed; see CliCommandSpec.stdinPrompt. */
  stdinPrompt?: string;
  /** Receives the writable attached to the container's stdin so the caller can
   *  inject more input mid-run. Only invoked when interactive. */
  onStdinWritable?: (writable: NodeJS.WritableStream) => void;
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

export interface DockerContainerCleanupResult {
  ok: boolean;
  removed: string[];
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
  /** Remove only non-running containers that still mount this volume. A worker killed
   *  between `docker create` and `docker start` can otherwise leave a Created helper
   *  container pinning an auth volume forever. Running containers are never selected. */
  removeStoppedContainersUsingVolume?(name: string): Promise<DockerContainerCleanupResult>;
}

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
/** Budget an invocation that names no timeout actually gets. Exported so the soft
 *  timeout winds a CLI down against the budget this runner will SIGKILL it on, not
 *  against a second copy of the number. */
export const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 1000;

async function spawnAndCollect(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
    signal?: AbortSignal;
    env?: Record<string, string>;
    interactive?: boolean;
    stdinInitial?: string;
    /** The prompt when it is too large for argv; written once, then stdin is
     *  closed. See CliCommandSpec.stdinPrompt. */
    stdinPrompt?: string;
    onStdinWritable?: (writable: NodeJS.WritableStream) => void;
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

    const interactive = opts.interactive === true;
    // A prompt delivered over stdin needs the pipe just as much as a steerable
    // run does, but for one write rather than a conversation.
    const needsStdin = interactive || typeof opts.stdinPrompt === 'string';
    const child = spawn(command, args, {
      stdio: [needsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });

    if (!interactive && typeof opts.stdinPrompt === 'string' && child.stdin) {
      child.stdin.on('error', () => {});
      // Written and CLOSED. Without the end() the CLI waits for more input and
      // the run dies on its timeout instead — which reads as a slow model rather
      // than a wiring mistake, so it is the one part of this worth stating.
      child.stdin.end(opts.stdinPrompt);
    }

    if (interactive && child.stdin) {
      // Swallow EPIPE: stdin can close (container exits, or we end it on the
      // result latch) while a steer write is in flight; an unhandled 'error'
      // on the stdin stream would crash the worker process.
      child.stdin.on('error', () => {});
      if (opts.stdinInitial) child.stdin.write(opts.stdinInitial);
      opts.onStdinWritable?.(child.stdin);
    }

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

    // stdout/stderr are always 'pipe' (positions 1,2), so never null; the
    // optional chaining only satisfies the widened ChildProcess type that the
    // computed stdio array (vs a literal) infers.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (debugStream) debugStream.write(chunk);
      const text = stdoutDecoder.write(chunk);
      if (text) {
        stdout += text;
        opts.onStdoutChunk?.(text);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
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
    for (const entry of opts.addHosts ?? []) flagArgs.push('--add-host', entry);
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

    // Per-container resource caps (machine-aware governor). --memory-swap == --memory
    // disables swap so the sandbox OOM-kills rather than driving the host into swap.
    if (opts.memoryLimitMb !== undefined) {
      flagArgs.push(
        '--memory',
        `${opts.memoryLimitMb}m`,
        '--memory-swap',
        `${opts.memoryLimitMb}m`,
      );
    }
    if (opts.cpuLimitMilli !== undefined) {
      flagArgs.push('--cpus', (opts.cpuLimitMilli / 1000).toFixed(3));
    }
    if (opts.pidsLimit !== undefined) {
      flagArgs.push('--pids-limit', String(opts.pidsLimit));
    }

    // SIGKILL/SIGTERM on the docker CLI client doesn't propagate to the
    // dockerd-side container; --rm only fires when the container itself exits.
    // Force-remove by name when our wrapper killed the client (timedOut) or the
    // run returned no exit code (signal abort), or a setup step failed.
    const forceRemove = () =>
      spawnAndCollect('docker', ['rm', '-f', containerName], { timeoutMs: 15_000 }).catch(
        () => undefined,
      );

    // Attaching the container's stdin is needed by BOTH stdin users, not just
    // steering: `stdinPrompt` writes the prompt once and closes. Gating this on
    // `interactive` alone opened a node-side pipe into a container docker had
    // given no stdin, so the prompt was written into a stream nothing read and
    // the CLI sat waiting until the run timed out — a hang that looks like a slow
    // model. Every adapter that delivers a large prompt over stdin depends on it.
    const attachStdin = opts.interactive === true || typeof opts.stdinPrompt === 'string';

    // Plain path: a single `docker run`. `-i` keeps the container's stdin open
    // (no `-t`: NDJSON wants a clean pipe).
    if (!opts.connectNetworks?.length) {
      const runArgs = ['run', '--rm'];
      if (attachStdin) runArgs.push('-i');
      runArgs.push('--name', containerName, ...flagArgs, opts.image, ...opts.cmd);
      const result = await spawnAndCollect('docker', runArgs, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        onStdoutChunk: opts.onStdoutChunk,
        onStderrChunk: opts.onStderrChunk,
        signal: opts.signal,
        interactive: opts.interactive,
        stdinInitial: opts.stdinInitial,
        stdinPrompt: opts.stdinPrompt,
        onStdinWritable: opts.onStdinWritable,
      });
      if (result.timedOut || result.exitCode === null) await forceRemove();
      return result;
    }

    // Multi-network path: `docker run` takes only one --network, so a second NIC
    // (the internal api-only network) requires create -> network connect -> start
    // (mirrors the squid gateway in egress-gateway.ts).
    // `-i` on create is mandatory for stdin attach: `docker start -a` cannot
    // attach stdin to a container created without OpenStdin (Hole A).
    const createArgs = ['create', '--rm'];
    if (attachStdin) createArgs.push('-i');
    createArgs.push('--name', containerName, ...flagArgs, opts.image, ...opts.cmd);
    const created = await spawnAndCollect('docker', createArgs, { timeoutMs: 30_000 });
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
    const startArgs = ['start', '--attach'];
    if (attachStdin) startArgs.push('--interactive');
    startArgs.push(containerName);
    const result = await spawnAndCollect('docker', startArgs, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      signal: opts.signal,
      interactive: opts.interactive,
      stdinInitial: opts.stdinInitial,
      stdinPrompt: opts.stdinPrompt,
      onStdinWritable: opts.onStdinWritable,
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

  async removeStoppedContainersUsingVolume(name) {
    // Multiple values for one Docker filter are ORed. Deliberately exclude `running`,
    // `paused` and `restarting`: task completion can race its best-effort step-summary
    // invocation, and cleanup must never kill work that is still in flight.
    const listed = await spawnAndCollect(
      'docker',
      [
        'ps',
        '-aq',
        '--filter',
        `volume=${name}`,
        '--filter',
        'status=created',
        '--filter',
        'status=exited',
        '--filter',
        'status=dead',
      ],
      { timeoutMs: 15_000 },
    );
    if (listed.exitCode !== 0) {
      return {
        ok: false,
        removed: [],
        stderr: listed.stderr,
        error: listed.error,
      };
    }
    const ids = listed.stdout.split(/\s+/).filter((id) => id.length > 0);
    if (ids.length === 0) return { ok: true, removed: [], stderr: '' };
    const removed = await spawnAndCollect('docker', ['rm', '-f', ...ids], {
      timeoutMs: 30_000,
    });
    return {
      ok: removed.exitCode === 0,
      removed: removed.exitCode === 0 ? ids : [],
      stderr: removed.stderr,
      error: removed.error,
    };
  },
};
