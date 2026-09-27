import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hardenGitArgs } from '@haive/shared/git-args';

export { hardenGitArgs };

const exec = promisify(execFile);

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** execFile kills a child whose output outgrows its buffer, 1 MiB by default, and a merge or a
 *  commit killed that way is left half-written; git's output grows with the repository. */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** No host git command waits for a person at a prompt. */
export const GIT_BASE_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0' };

/** Every host-side git process starts here, so the hardening in `hardenGitArgs` cannot be skipped
 *  by a new call site. `git-exec-guard.test.ts` is what keeps that true. */
function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...GIT_BASE_ENV, ...(env ?? {}) };
}

/** Run a git command, capturing stdout/stderr/exit code instead of throwing. The
 *  identical helper was inlined in several steps (11a-gate-4-push, 12-worktree-cleanup);
 *  centralised here. `env` merges over process.env when provided. */
export async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
  io?: { maxBuffer?: number; encoding?: BufferEncoding; input?: Buffer },
): Promise<GitRunResult> {
  try {
    const { input, ...output } = io ?? {};
    const run = exec('git', hardenGitArgs(args), {
      cwd,
      env: gitEnv(env),
      maxBuffer: GIT_MAX_BUFFER,
      ...output,
    });
    if (input) {
      // git can exit before reading all of it, which fails that write rather than the run.
      run.child.stdin?.on('error', () => undefined);
      run.child.stdin?.end(input);
    }
    const { stdout, stderr } = await run;
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
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
  const { stdout, stderr } = await exec('git', hardenGitArgs(args), {
    maxBuffer: GIT_MAX_BUFFER,
    ...rest,
    env: gitEnv(env),
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/** A streaming caller keeps `spawn` itself, so node's own stdio overloads still narrow its pipes;
 *  what it must not skip is `hardenGitArgs`, which `git-exec-guard.test.ts` checks. */
