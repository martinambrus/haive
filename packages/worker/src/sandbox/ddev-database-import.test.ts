import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import type { schema } from '@haive/database';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mock.spawn,
}));
import { importDdevDatabaseSnapshot } from './ddev-database-import.js';
const snapshot = {
  id: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '00000000-0000-4000-8000-000000000002',
} as typeof schema.databaseSnapshots.$inferSelect;

describe('saved database streaming into an already running DDEV runner', () => {
  let root: string;
  const oldRoot = process.env.REPO_STORAGE_ROOT;
  const handle = { container: 'already-running', projectDir: '/repos/project' };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'haive-database-import-test-'));
    process.env.REPO_STORAGE_ROOT = root;
    mock.spawn.mockReset();
  });
  afterEach(async () => {
    if (oldRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  function runner(code = 0) {
    const received: Buffer[] = [];
    mock.spawn.mockImplementation((_cmd, _args, opts) => {
      const stdin = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((_signal?: string) => {
          queueMicrotask(() => child.emit('close', 1));
          return true;
        }),
      });
      stdin.on('data', (bytes: Buffer) => received.push(bytes));
      stdin.on('finish', () => {
        child.stdout.write('Database imported\n');
        child.emit('close', code);
      });
      opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      return child;
    });
    return received;
  }
  it('streams the exact gzip bytes through stdin without recreating a container or staging a dump', async () => {
    const bytes = gzipSync(Buffer.from('CREATE TABLE example (id integer);\n'.repeat(100000)));
    await writeFileNoFollow(root, databaseSnapshotRel(snapshot), bytes, { createParents: true });
    const received = runner();
    const progress = vi.fn();
    expect(
      (await importDdevDatabaseSnapshot(handle, snapshot, new AbortController().signal, progress))
        .exitCode,
    ).toBe(0);
    expect(Buffer.concat(received)).toEqual(bytes);
    expect(mock.spawn).toHaveBeenCalledOnce();
    expect(mock.spawn.mock.calls[0]![1]).toEqual([
      'exec',
      '-i',
      '-u',
      'ddev',
      'already-running',
      'bash',
      '-lc',
      'cd /repos/project && set -o pipefail && gzip -dc | ddev import-db',
    ]);
    expect(progress).toHaveBeenCalledWith('Database imported');
  });
  it('reports a failed import and refuses missing or linked snapshot paths', async () => {
    await expect(
      importDdevDatabaseSnapshot(handle, snapshot, new AbortController().signal),
    ).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
    await writeFileNoFollow(root, databaseSnapshotRel(snapshot), gzipSync(Buffer.from('SQL')), {
      createParents: true,
    });
    runner(1);
    expect(
      (await importDdevDatabaseSnapshot(handle, snapshot, new AbortController().signal)).exitCode,
    ).toBe(1);
    await rm(path.join(root, '_database_snapshots'), { recursive: true });
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), path.join(root, '_database_snapshots'));
    mock.spawn.mockClear();
    await expect(
      importDdevDatabaseSnapshot(handle, snapshot, new AbortController().signal),
    ).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('does not start an import after cancellation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(importDdevDatabaseSnapshot(handle, snapshot, abort.signal)).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  });
});
