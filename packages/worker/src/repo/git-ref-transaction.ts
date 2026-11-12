import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { safeErrorMessage } from '@haive/shared/logger';
import { GIT_BASE_ENV, gitDefaultTimeoutMs, hardenGitArgs } from './git-exec.js';

/** Only process/protocol failures use this type; caller callback errors keep their identity. */
export class GitRefTransactionError extends Error {}

/** Git exited without acknowledging start; the transaction protocol is unavailable. */
export class GitRefTransactionsUnsupportedError extends GitRefTransactionError {}

/** Probe with an empty transaction before callers set aside or refresh checkout files. */
export async function checkGitRefTransactions(cwd: string): Promise<void> {
  await refTransaction(cwd);
}

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
  return refTransaction(cwd, { ref, next, expected, move });
}

async function refTransaction(
  cwd: string,
  change?: { ref: string; next: string; expected: string; move: () => Promise<boolean> },
): Promise<boolean> {
  const args = ['update-ref', '-m', 'Undo merge', '--stdin'];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('git', hardenGitArgs(args), {
      cwd,
      env: { ...process.env, ...GIT_BASE_ENV },
      stdio: 'pipe',
    });
  } catch (error) {
    throw new GitRefTransactionError(safeErrorMessage(error), { cause: error });
  }
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
  let closed = false;
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    }),
  );
  const timeoutMs = gitDefaultTimeoutMs(hardenGitArgs(args));
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const failure = () =>
    new GitRefTransactionError(
      spawnError
        ? spawnError.message
        : timedOut
          ? 'Git ref transaction timed out'
          : `Git ref transaction failed${detail.trim() ? `: ${detail.trim()}` : ''}`,
      { cause: spawnError },
    );
  const command = async (input: string, reply: string) => {
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed)
      throw failure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.write(input + '\n');
      const line = await Promise.race([
        replies.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(failure());
          }, timeoutMs);
        }),
      ]);
      if (line.done && input === 'start' && !spawnError)
        throw new GitRefTransactionsUnsupportedError(failure().message);
      if (line.done || line.value !== reply) throw failure();
    } catch (error) {
      if (error instanceof GitRefTransactionError) throw error;
      throw new GitRefTransactionError(safeErrorMessage(error), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };
  const waitForExit = async (ms: number) => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const finish = async (abort: boolean) => {
    // EOF aborts even if a pending protocol read timed out. Do not wait for an
    // abort ack: that read may still own the next reply. Git gets the first
    // chance to remove its locks itself, followed by its signal cleanup handler.
    if (!child.stdin.destroyed && !child.stdin.writableEnded)
      child.stdin.end(abort ? 'abort\n' : undefined);
    // After `commit: ok` the ref has moved and git has nothing left but to exit; give
    // it longer before a signal turns a finished move into a reported failure.
    if (!(await waitForExit(abort ? 1000 : 10_000))) {
      child.kill('SIGTERM');
      if (!(await waitForExit(1000))) child.kill('SIGKILL');
    }
    return exited;
  };
  let committed = false;
  try {
    await command('start', 'start: ok');
    if (!change) return false;
    await command(`update ${change.ref} ${change.next} ${change.expected}\nprepare`, 'prepare: ok');
    if (!(await change.move())) return false;
    await command('commit', 'commit: ok');
    committed = true;
    if ((await finish(false)) !== 0) throw failure();
    return true;
  } finally {
    await finish(!committed);
    lines.close();
  }
}
