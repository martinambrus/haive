import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { logger } from '@haive/shared';

/** uid/gid an extraction or document tool runs as. NOT 1000: that uid owns every repository on the
 *  volume, so a tool escaping its destination would be writing as the owner of everything it could
 *  reach. 65534 (nobody) owns nothing. A worker that is not root cannot setuid at all — CI, and any
 *  non-root deployment — so there it stays the current user, which is no worse than before. */
export const EXTRACT_UID = 65534;

/** The fd the first of `fds` becomes in the child; each next one takes the next number. */
export const FIRST_SLOT = 3;

/** How the child names the descriptor it was handed in `slot`. `/proc/self` resolves in the CHILD,
 *  so the slot is what matters, never the fd number the parent holds the file under. */
export function childFd(slot: number): string {
  return `/proc/self/fd/${slot}`;
}

export interface RunToolOptions {
  /** Held descriptors, handed to the child as fd `FIRST_SLOT`, `FIRST_SLOT + 1`, … in order. */
  fds?: readonly FileHandle[];
  /** Streamed to the child's stdin from offset 0; without it stdin is closed. */
  stdin?: FileHandle;
  /** Capture stdout up to this many bytes, killing the child past it; without it stdout is dropped. */
  maxStdout?: number;
  /** Exit codes that count as success. */
  okExits?: readonly number[];
  /** Kills the child with SIGKILL when aborted; the rejection carries `code: 'ABORT_ERR'`. */
  signal?: AbortSignal;
}

const MAX_STDERR = 64 * 1024;

/**
 * Run an extraction or document tool on files the worker already holds open.
 *
 * The child is handed descriptors, never a repository path: a path is resolved by the child, by
 * name, after the worker last looked at it, and the trees these tools read are written by
 * repositories and sandboxed agents. Its environment is PATH and LANG alone, since the worker's
 * holds `CONFIG_ENCRYPTION_KEY`, `DATABASE_URL` and `JWT_SECRET`, and `TAR_OPTIONS` or `UNZIP` would
 * be honoured if anything set them. Under a root worker it runs as `EXTRACT_UID`.
 */
export function runTool(
  cmd: string,
  args: readonly string[],
  opts: RunToolOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const asRoot = process.getuid?.() === 0;
  const okExits = opts.okExits ?? [0];
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: [
        opts.stdin ? 'pipe' : 'ignore',
        opts.maxStdout === undefined ? 'ignore' : 'pipe',
        'pipe',
        ...(opts.fds ?? []).map((fh) => fh.fd),
      ],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C' },
      ...(asRoot ? { uid: EXTRACT_UID, gid: EXTRACT_UID } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      killSignal: 'SIGKILL',
    });
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (opts.maxStdout !== undefined && stdoutBytes > opts.maxStdout) {
        proc.kill('SIGKILL');
        fail(new Error(`${cmd} wrote more than ${opts.maxStdout} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });
    // The stream does not own the handle: Node 26 turns a FileHandle reclaimed without an explicit
    // close into a hard ERR_INVALID_STATE, so the caller closes it and the stream only reads.
    const input = opts.stdin?.createReadStream({ autoClose: false, start: 0 });
    if (input && proc.stdin) {
      // A tool that rejects its input exits while it is still being written, so a broken pipe is
      // the normal shape of that failure: the exit code is what reports it.
      proc.stdin.on('error', () => undefined);
      input.on('error', fail);
      input.pipe(proc.stdin);
    }
    proc.on('error', fail);
    proc.on('close', (code) => {
      input?.destroy();
      if (settled) return;
      if (code !== null && okExits.includes(code)) {
        settled = true;
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr, exitCode: code });
        return;
      }
      fail(new Error(`${cmd} failed (exit ${code ?? 'killed'}): ${stderr.trim()}`));
    });
  });
}

/**
 * Let the extraction uid open a held file through its slot, for as long as the caller needs it. A
 * tool that re-opens `/proc/self/fd/N` rather than reading the descriptor (unzip does, since it
 * seeks) is checked against the file's own mode as that uid. The api writes every upload 0644, so
 * this is normally a no-op. A file the uid cannot read is opened up through the descriptor, never
 * by name, and only while it has one name: re-moding a hard link would open up its other names
 * too, so such a file is refused instead. Answers the restore to call once the tool is done, or
 * null when nothing was changed.
 */
export async function letToolRead(fh: FileHandle): Promise<(() => Promise<void>) | null> {
  if (process.getuid?.() !== 0) return null;
  const st = await fh.stat();
  if ((st.mode & 0o004) !== 0) return null;
  if (st.nlink !== 1) {
    throw new Error('the file has other links and is not readable by the extraction user');
  }
  const mode = st.mode & 0o7777;
  await fh.chmod(mode | 0o004);
  return () =>
    fh.chmod(mode).catch((err: unknown) => {
      logger.warn({ err }, 'could not restore the mode of a file opened to the extraction user');
    });
}
