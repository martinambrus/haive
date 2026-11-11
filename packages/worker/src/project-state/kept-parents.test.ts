import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import { keptFilesOf, restorePendingKeptMetadata, type KeptMetadata } from './kept-metadata.js';
import { putBackProjections, restoreKeptMetadata } from './set-aside.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(capture: KeptMetadata) {
  const root = await mkdtemp(join(tmpdir(), 'kept-parents-'));
  roots.push(root);
  let pending: Record<string, KeptMetadata> | null = { [root]: capture };
  const dialect = new PgDialect();
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ kept: pending }] }) }) }),
    execute: async (statement: SQL) => {
      if (dialect.sqlToQuery(statement).sql.trimStart().startsWith('UPDATE')) pending = null;
    },
    transaction: async (run: (tx: Database) => Promise<unknown>) => run(db),
  } as unknown as Database;
  return {
    root,
    db,
    pending: () => pending,
    recover: () => restorePendingKeptMetadata(db, 'repo', root, restoreKeptMetadata),
  };
}
const parent = '.haive-data/state';
const owner = { uid: process.getuid!(), gid: process.getgid!() };
const capture = {
  '.haive-data/state/tracked.json': { parents: [{ path: parent, owner, mode: 0o700 }] },
};

it('an absent parent stays pending without failing recovery, then is restored once', async () => {
  const f = await fixture(capture);
  expect(await restoreKeptMetadata(f.root, keptFilesOf(capture))).toBe('pending');
  expect(await f.recover()).toBe(true);
  expect(f.pending()).toEqual({ [f.root]: capture });
  await mkdir(join(f.root, parent), { recursive: true, mode: 0o755 });
  expect(await f.recover()).toBe(true);
  expect(f.pending()).toBeNull();
  expect((await lstat(join(f.root, parent))).mode & 0o7777).toBe(0o700);
  await chmod(join(f.root, parent), 0o755);
  expect(await f.recover()).toBe(true);
  expect((await lstat(join(f.root, parent))).mode & 0o7777).toBe(0o755);
});

it.each(['file', 'symlink'] as const)(
  'a parent replaced by a %s is a real restore conflict',
  async (kind) => {
    const f = await fixture(capture);
    await mkdir(join(f.root, '.haive-data'));
    if (kind === 'file') await writeFile(join(f.root, parent), 'user file');
    else await symlink('missing', join(f.root, parent));
    const warn = vi.spyOn(logger, 'warn');
    expect(await restoreKeptMetadata(f.root, keptFilesOf(capture))).toBe(false);
    expect(await f.recover()).toBe(false);
    expect(await f.recover()).toBe(false);
    expect(f.pending()).toEqual({ [f.root]: capture });
    // The sweep revisits a standing conflict every tick; it is reported once per path.
    expect(
      warn.mock.calls.filter(([fields]) => (fields as { path?: string }).path === parent),
    ).toHaveLength(1);
  },
);

it.each([false, true])(
  'a failure wins over an absent parent in either order: %s',
  async (reverse) => {
    const parents = [
      { path: '.haive-data/missing', owner, mode: 0o700 },
      { path: '.haive-data/conflict', owner, mode: 0o700 },
    ];
    if (reverse) parents.reverse();
    const metadata = { 'tracked.json': { parents } };
    const f = await fixture(metadata);
    await mkdir(join(f.root, '.haive-data'));
    await writeFile(join(f.root, '.haive-data/conflict'), 'user file');
    expect(await restoreKeptMetadata(f.root, keptFilesOf(metadata))).toBe(false);
    expect(await f.recover()).toBe(false);
    expect(f.pending()).toEqual({ [f.root]: metadata });
  },
);

it.each(['directory', 'symlink'] as const)(
  'put-back EEXIST refuses a %s without consuming the capture',
  async (kind) => {
    const path = '.haive-data/plan.json';
    const metadata = { [path]: { owner, mode: 0o600 } };
    const f = await fixture(metadata);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: f.root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@local',
        'commit',
        '--allow-empty',
        '-qm',
        'initial',
      ],
      { cwd: f.root },
    );
    await mkdir(join(f.root, '.haive-data'));
    if (kind === 'directory') await mkdir(join(f.root, path));
    else await symlink('missing', join(f.root, path));
    const kept = keptFilesOf(metadata);
    kept.get(path)!.bytes = Buffer.from('captured');
    await expect(putBackProjections(f.db, 'repo', f.root, kept)).rejects.toThrow(
      'file metadata not restored',
    );
    expect(f.pending()).toEqual({ [f.root]: metadata });
    expect((await lstat(join(f.root, path))).isSymbolicLink()).toBe(kind === 'symlink');
  },
);
