import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { gitSubcommandIndex, hardenGitArgs } from '@haive/shared/git-args';

export { hardenGitArgs };

const exec = promisify(execFile);

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Set with GIT_NO_EXIT: Node's error code, e.g. `ENOENT` or `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, or the signal, e.g. `SIGKILL`. */
  noExit?: string;
}

/** The `code` of a run that ended without an exit status: git could not start, a signal other than
 *  the time limit ended it, or its output outgrew the buffer. No exit status is negative, so a
 *  reader that takes exit 1 for "no" never takes this for an answer. */
export const GIT_NO_EXIT = -1;

/** The `code` of a run that outlived its time limit and was killed for it. */
export const GIT_TIMED_OUT = 124;

/** Whether a run gave no answer: it ended without an exit status or at its time limit. A reader
 *  that takes a non-zero exit for "no", "absent" or "clean" must not take this for one. */
export function gitGaveNoAnswer(res: Pick<GitRunResult, 'code'>): boolean {
  return res.code === GIT_NO_EXIT || res.code === GIT_TIMED_OUT;
}

/** execFile kills a child whose output outgrows its buffer, 1 MiB by default, and a merge or a
 *  commit killed that way is left half-written; git's output grows with the repository. */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** No host git command waits for a person at a prompt. */
export const GIT_BASE_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0' };

/** Subcommands that move a whole repository or its history over a network or a disk. */
const LONG_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'gc',
  'repack',
  'prune',
  'fsck',
  'merge',
  'rebase',
  'cherry-pick',
  'submodule',
  'lfs',
]);

/** The default bound in ms for a git run whose caller gave none; a test shortens it, nothing reads it from config. */
export const gitTimeoutLimits = { long: 30 * 60_000, short: 10 * 60_000 };

/** The default bound for an argv, found from its first non-option argument; pass the hardened argv. */
export function gitDefaultTimeoutMs(argv: readonly string[]): number {
  const at = gitSubcommandIndex(argv);
  return at !== -1 && LONG_GIT_SUBCOMMANDS.has(argv[at]!)
    ? gitTimeoutLimits.long
    : gitTimeoutLimits.short;
}

function timedOutLine(argv: readonly string[], timeout: number): string {
  const at = gitSubcommandIndex(argv);
  return `git ${at === -1 ? '' : argv[at]} timed out after ${Math.round(timeout / 1000)} s`;
}

function withLine(stderr: string, line: string): string {
  return `${stderr}${stderr === '' || stderr.endsWith('\n') ? '' : '\n'}${line}\n`;
}

/** Node's timeout kill is a SIGTERM with no exit code; a maxBuffer kill carries a string code. */
function killedByTimeout(err: { killed?: boolean; signal?: string; code?: unknown }): boolean {
  return err.killed === true && err.signal === 'SIGTERM' && typeof err.code !== 'string';
}

/** Every host-side git process starts here, so the hardening in `hardenGitArgs` cannot be skipped
 *  by a new call site. `git-exec-guard.test.ts` is what keeps that true. */
function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...GIT_BASE_ENV, ...(env ?? {}) };
}

/** An abort callback precedes exit. Stop the whole git group (including index-pack), then
 * wait for its pipes to close before a caller removes files the group could still write. */
function abortExitWait(child: ChildProcess, signal: AbortSignal) {
  let closed = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const killGroup = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(name);
    }
  };
  const abort = () => {
    if (closed || stopping) return;
    stopping = true;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
    // Even an uninterruptible child must not hold the worker forever.
    waitTimer = setTimeout(finish, 2000);
  };
  const close = () => {
    closed = true;
    // Destroying our pipes can close the leader before its group has stopped.
    // Keep escalation and the bounded wait alive for any remaining writers.
    if (stopping && child.pid) {
      try {
        process.kill(-child.pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    }
    clearTimeout(killTimer);
    clearTimeout(waitTimer);
    finish();
  };
  child.once('close', close);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    wait,
    stop: abort,
    dispose: () => {
      signal.removeEventListener('abort', abort);
      child.removeListener('close', close);
      clearTimeout(killTimer);
      clearTimeout(waitTimer);
    },
  };
}

/** Run a git command, capturing stdout/stderr/exit code instead of throwing. The
 *  identical helper was inlined in several steps (11a-gate-4-push, 12-worktree-cleanup);
 *  centralised here. `env` merges over process.env when provided. `io.timeout` (ms, 0 for none)
 *  kills a git that outlives it, which reads as code 124; without it `gitDefaultTimeoutMs` applies. */
export async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
  io?: {
    maxBuffer?: number;
    encoding?: BufferEncoding;
    input?: Buffer;
    timeout?: number;
    allowFileTransport?: boolean;
    signal?: AbortSignal;
  },
): Promise<GitRunResult> {
  const { input, allowFileTransport, ...output } = io ?? {};
  const argv = hardenGitArgs(args, { allowFileTransport });
  const timeout = output.timeout ?? gitDefaultTimeoutMs(argv);
  let child: ChildProcess;
  try {
    child = spawn('git', argv, {
      cwd,
      env: gitEnv(env),
      detached: !!output.signal,
      signal: output.signal,
    });
  } catch (error) {
    const noExit = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return {
      stdout: '',
      stderr: withLine('', `git ended without an exit status in ${cwd} (${noExit})`),
      code: GIT_NO_EXIT,
      noExit,
    };
  }
  const abortWait = output.signal ? abortExitWait(child, output.signal) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let overflow = false;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxBuffer = output.maxBuffer ?? GIT_MAX_BUFFER;
  const stop = () => {
    if (abortWait) abortWait.stop();
    else child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, maxBuffer - stdoutBytes);
    stdout.push(chunk.subarray(0, remaining));
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxBuffer) {
      overflow = true;
      stop();
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, maxBuffer - stderrBytes);
    stderr.push(chunk.subarray(0, remaining));
    stderrBytes += chunk.length;
    if (stderrBytes > maxBuffer) {
      overflow = true;
      stop();
    }
  });
  if (input) {
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  }
  try {
    const result = await new Promise<GitRunResult>((resolve) => {
      const finish = (code: number | null, signal?: string | null, errorCode?: string) => {
        const out = Buffer.concat(stdout).toString(output.encoding ?? 'utf8');
        const err = Buffer.concat(stderr).toString(output.encoding ?? 'utf8');
        // A git that handles SIGTERM and exits by itself still supplies a real answer.
        if (timedOut && code === null && !errorCode && !overflow) {
          resolve({
            stdout: out,
            stderr: withLine(err, timedOutLine(argv, timeout)),
            code: GIT_TIMED_OUT,
          });
        } else if (errorCode || overflow || code === null) {
          const noExit =
            errorCode ?? (overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : (signal ?? 'unknown'));
          resolve({
            stdout: out,
            stderr: withLine(err, `git ended without an exit status in ${cwd} (${noExit})`),
            code: GIT_NO_EXIT,
            noExit,
          });
        } else resolve({ stdout: out, stderr: err, code });
      };
      child.once('error', (error: NodeJS.ErrnoException) =>
        finish(null, null, error.code ?? 'unknown'),
      );
      child.once('close', (code, signal) => finish(code, signal));
      if (timeout > 0)
        timer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          timedOut = true;
          stop();
        }, timeout);
    });
    if (timedOut || overflow || output.signal?.aborted) await abortWait?.wait;
    return result;
  } finally {
    clearTimeout(timer);
    abortWait?.dispose();
  }
}

export interface GitExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
  encoding?: BufferEncoding;
}

/** The throwing form, for callers that handle a non-zero exit through catch. */
export async function gitExec(
  args: string[],
  opts: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { env, ...rest } = opts;
  const argv = hardenGitArgs(args);
  const timeout = rest.timeout ?? gitDefaultTimeoutMs(argv);
  try {
    const { stdout, stderr } = await exec('git', argv, {
      maxBuffer: GIT_MAX_BUFFER,
      ...rest,
      timeout,
      env: gitEnv(env),
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as Error & { killed?: boolean; signal?: string; code?: unknown };
    if (timeout > 0 && killedByTimeout(e)) e.message = timedOutLine(argv, timeout);
    throw err;
  }
}

/** A streaming caller keeps `spawn` itself, so node's own stdio overloads still narrow its pipes;
 *  what it must not skip is `hardenGitArgs`, which `git-exec-guard.test.ts` checks. */
