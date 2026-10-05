import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { openFileNoFollow, removeNoFollow, renameNoFollow } from '@haive/shared/fs-safe';
import { buildDdevCommand, type DdevRunnerHandle } from './ddev-runner.js';

/** Binary stdout goes straight to a held descriptor, never through the text/tail progress buffer. */
export async function exportDdevDatabase(
  handle: DdevRunnerHandle,
  anchor: string,
  rel: string,
  signal: AbortSignal,
  openPartial?: () => Promise<Awaited<ReturnType<typeof openFileNoFollow>>>,
): Promise<{ sizeBytes: number; sha256: string }> {
  const partial = `${rel}.partial`;
  const file = openPartial
    ? await openPartial()
    : await (async () => {
        await removeNoFollow(anchor, partial);
        return openFileNoFollow(anchor, partial, 'create-exclusive', {
          createParents: true,
          fileMode: 0o644,
        });
      })();
  if (!file) throw new Error('Database export file could not be opened');
  let promoted = false;
  try {
    const command = buildDdevCommand(handle.projectDir, 'export-db --gzip', 1_800_000);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'docker',
        ['exec', '-u', 'ddev', handle.container, 'bash', '-lc', command.shell],
        {
          stdio: ['ignore', file.fd, 'pipe'],
          signal,
        },
      );
      let stderr = '';
      let timedOut = false;
      child.stderr?.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-1500);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, command.hostTimeoutMs);
      child.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && !timedOut) resolve();
        else
          reject(
            new Error(
              `DDEV database export ${timedOut ? 'timed out' : `failed (${code})`}: ${stderr}`,
            ),
          );
      });
    });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let sqlBytes = 0;
    // Validate the complete gzip stream, including its trailer, with bounded memory.
    const readable = await openFileNoFollow(anchor, partial, 'read', { strict: true });
    if (!readable) throw new Error('Exported database dump disappeared');
    try {
      await pipeline(
        readable.createReadStream({ start: 0, autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _encoding, next) {
            sizeBytes += chunk.length;
            hash.update(chunk);
            next(null, chunk);
          },
        }),
        createGunzip(),
        new Writable({
          write(chunk: Buffer, _encoding, next) {
            sqlBytes += chunk.length;
            next();
          },
        }),
        { signal },
      );
    } finally {
      await readable.close();
    }
    if (sqlBytes === 0) throw new Error('DDEV exported an empty database dump');
    await file.sync();
    signal.throwIfAborted();
    await renameNoFollow(anchor, partial, rel, { noReplace: true });
    promoted = true;
    return { sizeBytes, sha256: hash.digest('hex') };
  } finally {
    await file.close();
    if (!promoted) await removeNoFollow(anchor, partial).catch(() => undefined);
  }
}
