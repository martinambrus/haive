import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { mkdtemp, rm, readFile, access, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('./ddev-runner.js', () => ({
  buildDdevCommand: () => ({ shell: 'locked export-db', hostTimeoutMs: 30_000 }),
}));
import { exportDdevDatabase } from './ddev-database-export.js';
import { openFileNoFollow, removeNoFollow } from '@haive/shared/fs-safe';

describe('DDEV database export files', () => {
  let root: string;
  const handle = { container: 'test-runner', projectDir: '/repos/test' };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'haive-database-export-test-'));
    mock.spawn.mockReset();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function exportBytes(bytes: Buffer, code = 0) {
    mock.spawn.mockImplementation((_command, _args, options) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        writeSync(options.stdio[1], bytes);
        child.stderr.emit('data', Buffer.from('export diagnostics'));
        child.emit('close', code);
      });
      return child;
    });
  }

  it('preserves binary stdout, validates gzip, and publishes only the complete export', async () => {
    const bytes = gzipSync(Buffer.from('CREATE TABLE t(id integer);\n'.repeat(100_000)));
    exportBytes(bytes);
    const result = await exportDdevDatabase(
      handle,
      root,
      'snapshots/test.sql.gz',
      new AbortController().signal,
    );
    expect(await readFile(path.join(root, 'snapshots/test.sql.gz'))).toEqual(bytes);
    expect(result).toEqual({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await expect(access(path.join(root, 'snapshots/test.sql.gz.partial'))).rejects.toThrow();
    expect(mock.spawn.mock.calls[0]![2].stdio).toEqual(['ignore', expect.any(Number), 'pipe']);
  });

  it.each(['command failure', 'truncated gzip', 'empty gzip'])(
    'removes a partial file after %s',
    async (failure) => {
      const bytes = gzipSync(
        Buffer.from(failure === 'empty gzip' ? '' : 'CREATE TABLE t(id integer);'),
      );
      exportBytes(
        failure === 'truncated gzip' ? bytes.subarray(0, bytes.length - 4) : bytes,
        failure === 'command failure' ? 1 : 0,
      );
      await expect(
        exportDdevDatabase(handle, root, 'test.sql.gz', new AbortController().signal),
      ).rejects.toThrow();
      await expect(access(path.join(root, 'test.sql.gz'))).rejects.toThrow();
      await expect(access(path.join(root, 'test.sql.gz.partial'))).rejects.toThrow();
    },
  );

  it('refuses a symlink in the destination without touching the target', async () => {
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), path.join(root, 'snapshots'));
    await expect(
      exportDdevDatabase(handle, root, 'snapshots/test.sql.gz', new AbortController().signal),
    ).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
    await expect(access(path.join(root, 'elsewhere/test.sql.gz'))).rejects.toThrow();
  });

  it('cannot leave a dump after cleanup unlinks its held partial descriptor', async () => {
    exportBytes(gzipSync(Buffer.from('CREATE TABLE t(id integer);')));
    await expect(
      exportDdevDatabase(handle, root, 'test.sql.gz', new AbortController().signal, async () => {
        const file = await openFileNoFollow(root, 'test.sql.gz.partial', 'create-exclusive');
        await removeNoFollow(root, 'test.sql.gz.partial');
        return file;
      }),
    ).rejects.toThrow('disappeared');
    await expect(access(path.join(root, 'test.sql.gz'))).rejects.toThrow();
    await expect(access(path.join(root, 'test.sql.gz.partial'))).rejects.toThrow();
  });

  it('creates no files when the ownership check refuses an export', async () => {
    await expect(
      exportDdevDatabase(handle, root, 'test.sql.gz', new AbortController().signal, async () => {
        throw new Error('step superseded');
      }),
    ).rejects.toThrow('superseded');
    expect(mock.spawn).not.toHaveBeenCalled();
    await expect(access(path.join(root, 'test.sql.gz.partial'))).rejects.toThrow();
  });
});
