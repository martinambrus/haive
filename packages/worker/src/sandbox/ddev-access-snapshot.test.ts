import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessSnapshotProgram, parseAccessSnapshotResult } from './ddev-access-snapshot.js';

const exec = promisify(execFile);
let root: string;
let snapshots: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ddev-access-snapshot-'));
  snapshots = path.join(root, '.ddev/db_snapshots');
  await mkdir(snapshots, { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await writeFile(
    path.join(root, 'bin/ddev'),
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs/promises');
async function main() {
  const args = process.argv.slice(2);
  const name = args.find(a => a.startsWith('--name=')).slice(7);
  const directory = '.ddev/db_snapshots';
  if (args.includes('--cleanup')) {
    for (const file of await fs.readdir(directory)) if (file.startsWith(name + '-')) await fs.rm(directory + '/' + file, { recursive: true });
    return;
  }
  await fs.writeFile('snapshot-started', '');
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.writeFile(directory + '/' + name + '-postgres_17.zst', 'database', { flag: 'wx' });
  if (process.env.FAIL_SNAPSHOT) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`,
    { mode: 0o755 },
  );
  env = { ...process.env, PATH: path.join(root, 'bin') + ':' + process.env.PATH };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function snapshot(extra: NodeJS.ProcessEnv = {}) {
  const { stdout } = await exec(
    'flock',
    ['--exclusive', path.join(root, 'lock'), process.execPath, '-e', accessSnapshotProgram('task')],
    { cwd: root, env: { ...env, ...extra }, timeout: 10_000 },
  );
  return parseAccessSnapshotResult('task', stdout);
}

describe('atomic access snapshot transaction', () => {
  it('selects a different slot after a concurrent predecessor completes and keeps its backup until restoration', async () => {
    const first = snapshot();
    // Start the second before the first has created its snapshot: selecting on
    // the host before flock would pick the same empty slot for both callers.
    for (let attempts = 0; ; attempts++) {
      try {
        await access(path.join(root, 'snapshot-started'));
        break;
      } catch {
        if (attempts === 100) throw new Error('First snapshot did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = snapshot();
    expect(await first).toEqual({ next: 'haive-access-task-0', previous: null });
    expect(await second).toEqual({ next: 'haive-access-task-1', previous: 'haive-access-task-0' });
    expect((await readdir(snapshots)).sort()).toEqual([
      'haive-access-task-0-postgres_17.zst',
      'haive-access-task-1-postgres_17.zst',
    ]);
  });

  it('leaves an interrupted copy provisional and retains the previous completed recovery point', async () => {
    await snapshot();
    await expect(snapshot({ FAIL_SNAPSHOT: '1' })).rejects.toThrow();
    expect((await readdir(snapshots)).sort()).toEqual([
      'haive-access-pending-task-postgres_17.zst',
      'haive-access-task-0-postgres_17.zst',
    ]);
    expect(await snapshot()).toEqual({
      next: 'haive-access-task-1',
      previous: 'haive-access-task-0',
    });
    expect((await readdir(snapshots)).sort()).toEqual([
      'haive-access-task-0-postgres_17.zst',
      'haive-access-task-1-postgres_17.zst',
    ]);
  });

  it('prunes obsolete legacy copies while preserving unrelated backups and the newest recovery point', async () => {
    await writeFile(path.join(snapshots, 'haive-access-task-100-postgres_17.zst'), 'old');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(snapshots, 'haive-access-task-200-postgres_17.zst'), 'new');
    await writeFile(path.join(snapshots, 'haive-import-task-postgres_17.zst'), 'import');
    await writeFile(path.join(snapshots, 'haive-access-other-0-postgres_17.zst'), 'other');
    expect(await snapshot()).toEqual({
      next: 'haive-access-task-0',
      previous: 'haive-access-task-200',
    });
    expect((await readdir(snapshots)).sort()).toEqual([
      'haive-access-other-0-postgres_17.zst',
      'haive-access-task-0-postgres_17.zst',
      'haive-access-task-200-postgres_17.zst',
      'haive-import-task-postgres_17.zst',
    ]);
  });

  it('rejects transaction metadata that could target another task or an arbitrary snapshot', () => {
    for (const next of ['haive-access-other-0', 'haive-import-task', 'haive-access-task-3']) {
      expect(() =>
        parseAccessSnapshotResult(
          'task',
          'HAIVE_ACCESS_SNAPSHOT=' + JSON.stringify({ next, previous: null }),
        ),
      ).toThrow();
    }
    expect(() => parseAccessSnapshotResult('task', 'missing metadata')).toThrow();
  });
});
