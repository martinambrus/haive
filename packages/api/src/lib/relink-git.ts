import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hardenGitArgs } from '@haive/shared/git-args';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { scrubErrorPaths } from '@haive/shared/logger';
import { redactGitText } from '@haive/shared/schemas';
import { HttpError } from '../context.js';

const execGit = promisify(execFile);
// A relink's git child still running after GIT_DEADLINE_MS gets SIGTERM, and SIGKILL only if it is
// still running GIT_KILL_GRACE_MS later. SIGTERM lets git remove the lock file it holds (MEASURED
// with git 2.43.0 and 2.54.0 on config writes held inside their lock windows: gone within 3 ms
// after the signal), while SIGKILL leaves `.git/config.lock` behind and fails the restore and every later
// relink. So SIGKILL is for a child that ignores SIGTERM, after a grace that is wide for git's
// cleanup and short for a waiting request.
const GIT_DEADLINE_MS = 10_000;
const GIT_KILL_GRACE_MS = 2_000;

export const relinkGit = async (
  root: string,
  args: string[],
): Promise<{
  ok: boolean;
  exitedClean: boolean;
  code: number;
  stdout: string;
  stderr: string;
}> => {
  let deadline: NodeJS.Timeout | undefined;
  let grace: NodeJS.Timeout | undefined;
  let deadlineFired = false;
  try {
    const run = execGit('git', hardenGitArgs(args), {
      cwd: root,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) },
    });
    deadline = setTimeout(() => {
      deadlineFired = true;
      // As execFile's own timeout does: close both pipes before the signal, so a grandchild that
      // still holds them cannot keep the call pending once git is gone. `child` is read with `?.`
      // because a stubbed execFile has none.
      run.child?.stdout?.destroy();
      run.child?.stderr?.destroy();
      run.child?.kill('SIGTERM');
      grace = setTimeout(() => run.child?.kill('SIGKILL'), GIT_KILL_GRACE_MS);
    }, GIT_DEADLINE_MS);
    const { stdout, stderr } = await run;
    // Closing the pipes can discard unread output even if git exited 0 in this turn.
    // Never accept that truncated output as a snapshot of the previous remote.
    if (deadlineFired)
      return { ok: false, exitedClean: true, code: -1, stdout: '', stderr: 'no answer' };
    return {
      ok: true,
      exitedClean: true,
      code: 0,
      stdout: stdout.toString().trim(),
      stderr: stderr.toString().trim(),
    };
  } catch (err) {
    const e = err as {
      code?: unknown;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    const code = typeof e.code === 'number' ? e.code : -1;
    return {
      ok: false,
      exitedClean: false,
      code,
      stdout: (e.stdout ?? '').toString().trim(),
      // execFile's message includes argv, which can contain credentials.
      stderr:
        (e.stderr ?? '').toString().trim() || (e.signal ? `signal ${e.signal}` : `exit ${code}`),
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(grace);
  }
};

export const gitFailureText = (result: { stderr: string; stdout: string }) =>
  scrubErrorPaths(redactGitText(result.stderr || result.stdout || 'no answer'));

export async function verifyRelinkCheckout(root: string): Promise<void> {
  const git = (args: string[]) => relinkGit(root, args);
  // Without its own .git entry, upward discovery would relink a parent checkout.
  const entry = await lstatNoFollow(root, '.git', { strict: true }).catch((err: unknown) => {
    throw new HttpError(409, `This repository could not be examined: ${scrubErrorPaths(err)}`);
  });
  if (!entry || entry.kind === 'symlink') {
    throw new HttpError(
      409,
      'This repository has no usable .git entry of its own, so it cannot have a remote',
    );
  }
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || !['true', 'false'].includes(inside.stdout)) {
    const reason = gitFailureText(inside);
    throw new HttpError(
      409,
      `This repository could not be examined: git rev-parse --is-inside-work-tree failed (exit ${inside.code}): ${reason}`,
    );
  }
  if (inside.stdout === 'false') {
    throw new HttpError(409, 'This repository is not a Git checkout, so it cannot have a remote');
  }
}
