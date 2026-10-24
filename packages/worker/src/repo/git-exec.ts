import { execFile } from 'node:child_process';
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

/** Run a git command, capturing stdout/stderr/exit code instead of throwing. The
 *  identical helper was inlined in several steps (11a-gate-4-push, 12-worktree-cleanup);
 *  centralised here. `env` merges over process.env when provided. `io.timeout` (ms, 0 for none)
 *  kills a git that outlives it, which reads as code 124; without it `gitDefaultTimeoutMs` applies. */
export async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
  io?: { maxBuffer?: number; encoding?: BufferEncoding; input?: Buffer; timeout?: number },
): Promise<GitRunResult> {
  const argv = hardenGitArgs(args);
  const { input, ...output } = io ?? {};
  const timeout = output.timeout ?? gitDefaultTimeoutMs(argv);
  try {
    const run = exec('git', argv, {
      cwd,
      env: gitEnv(env),
      maxBuffer: GIT_MAX_BUFFER,
      ...output,
      timeout,
    });
    if (input) {
      // git can exit before reading all of it, which fails that write rather than the run.
      run.child.stdin?.on('error', () => undefined);
      run.child.stdin?.end(input);
    }
    const { stdout, stderr } = await run;
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: unknown;
      killed?: boolean;
      signal?: string;
    };
    const stderr = (e.stderr ?? '').toString();
    if (timeout > 0 && killedByTimeout(e)) {
      return {
        stdout: (e.stdout ?? '').toString(),
        stderr: withLine(stderr, timedOutLine(argv, timeout)),
        code: GIT_TIMED_OUT,
      };
    }
    if (typeof e.code !== 'number') {
      const noExit = typeof e.code === 'string' ? e.code : (e.signal ?? 'unknown');
      return {
        stdout: (e.stdout ?? '').toString(),
        stderr: withLine(stderr, `git ended without an exit status in ${cwd} (${noExit})`),
        code: GIT_NO_EXIT,
        noExit,
      };
    }
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr,
      code: e.code,
    };
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
