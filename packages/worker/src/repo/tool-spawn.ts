import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import { openFileNoFollow, removeNoFollow } from '@haive/shared/fs-safe';

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
 * A descriptor on a held file that the extraction uid can open through its slot. A tool that
 * re-opens `/proc/self/fd/N` rather than reading the descriptor (unzip does, since it seeks) is
 * checked against the file's own mode as that uid. The api writes every upload 0644, so this is
 * normally the file itself. One that uid cannot read is copied through the descriptor into a
 * private file it can, whose name is gone before the tool starts, so the original's mode is never
 * changed and two extractions of one file share nothing. Close what it answers once the tool is
 * done.
 */
export async function toolReadable(
  fh: FileHandle,
): Promise<{ fh: FileHandle; close: () => Promise<void> }> {
  if (process.getuid?.() !== 0 || ((await fh.stat()).mode & 0o004) !== 0) {
    return { fh, close: async () => {} };
  }
  const rel = `.haive-tool-${randomUUID()}`;
  const copy = (await openFileNoFollow(os.tmpdir(), rel, 'create-exclusive', {
    fileMode: 0o604,
  }))!;
  try {
    await removeNoFollow(os.tmpdir(), rel);
    // Positional reads and writes on the two handles: neither stream would own its handle, and a
    // stream that does not emits no close for a pipeline to wait on.
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let pos = 0; ;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      for (let done = 0; done < bytesRead;) {
        const { bytesWritten } = await copy.write(buf, done, bytesRead - done, pos + done);
        done += bytesWritten;
      }
      pos += bytesRead;
    }
    return { fh: copy, close: () => copy.close() };
  } catch (err) {
    await copy.close();
    throw err;
  }
}
