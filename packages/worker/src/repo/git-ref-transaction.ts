import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { GIT_BASE_ENV, gitDefaultTimeoutMs, hardenGitArgs } from './git-exec.js';

/** Hold the branch's compare-and-swap lock while a caller updates its checkout.
 * The caller must not write the branch ref itself. A false result or a throw aborts.
 * EOF also aborts a prepared transaction if the worker dies. */
export async function withGitRefTransaction(
  cwd: string,
  ref: string,
  next: string,
  expected: string,
  move: () => Promise<boolean>,
): Promise<boolean> {
  const args = ['update-ref', '-m', 'Undo merge', '--stdin'];
  const child = spawn('git', hardenGitArgs(args), {
    cwd,
    env: { ...process.env, ...GIT_BASE_ENV },
  });
  let detail = '';
  let spawnError: Error | undefined;
  let timedOut = false;
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    detail = (detail + chunk).slice(0, 4096);
  });
  // A failed start/early exit can close stdin before a queued write completes.
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill('SIGKILL');
    },
    gitDefaultTimeoutMs(hardenGitArgs(args)),
  );
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const failure = () =>
    spawnError ??
    new Error(
      timedOut
        ? 'Git ref transaction timed out'
        : `Git ref transaction failed${detail.trim() ? `: ${detail.trim()}` : ''}`,
    );
  const command = async (input: string, reply: string) => {
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed)
      throw failure();
    child.stdin.write(input + '\n');
    const line = await replies.next();
    if (line.done || line.value !== reply) throw failure();
  };
  let committed = false;
  try {
    await command('start', 'start: ok');
    await command(`update ${ref} ${next} ${expected}\nprepare`, 'prepare: ok');
    if (!(await move())) return false;
    await command('commit', 'commit: ok');
    committed = true;
    child.stdin.end();
    if ((await exited) !== 0) throw failure();
    return true;
  } finally {
    try {
      if (!committed) await command('abort', 'abort: ok');
    } catch {
      // A failed prepare/closed process already aborted; preserve the original failure.
    } finally {
      child.stdin.end();
      // The protocol is finished. Bound a child that fails to exit after EOF too.
      await exited;
      clearTimeout(timer);
      lines.close();
    }
  }
}
