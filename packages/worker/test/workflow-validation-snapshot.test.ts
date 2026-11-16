import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  affectedValidationFiles,
  validationSnapshotDigest,
  readValidationSnapshot,
} from '../src/step-engine/steps/workflow/_validation-snapshot.js';

import * as changeReads from '../src/orchestrator/house-rules-dispatch.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function checkout() {
  const dir = await mkdtemp(path.join(tmpdir(), 'haive-validation-snapshot-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-qb', 'main');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'app.ts'), 'old');
  await writeFile(path.join(dir, '.gitignore'), 'ignored-output\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'task');
  await writeFile(path.join(dir, 'app.ts'), 'implementation');
  const fake = createFakeDb({ taskSteps: schema.taskSteps });
  fake.insert(schema.taskSteps, {
    taskId: '00000000-0000-4000-8000-000000000001',
    stepId: '01-worktree-setup',
    round: 0,
    output: { worktreePath: dir, baseBranch: 'main' },
  });
  const read = (options?: Parameters<typeof readValidationSnapshot>[1]) =>
    readValidationSnapshot(
      {
        db: fake.db as unknown as Database,
        taskId: '00000000-0000-4000-8000-000000000001',
      },
      options,
    );
  return { dir, git, read };
}

describe('the final changes affected since validation', () => {
  it('requires complete bytes to prove unchanged, retaining bounded-prefix validation otherwise', async () => {
    const w = await checkout();
    await writeFile(path.join(w.dir, 'app.ts'), 'abcd');
    expect(await w.read({ requireComplete: true, maxFileBytes: 4 })).not.toBeNull();
    await writeFile(path.join(w.dir, 'app.ts'), 'abcdX');
    expect(await w.read({ requireComplete: true, maxFileBytes: 4 })).toBeNull();
    expect(await w.read({ maxFileBytes: 4 })).not.toBeNull();
  });
  it('cannot prove equality from a nested checkout HEAD alone', async () => {
    const w = await checkout();
    w.git('init', '-q', 'nested');
    await writeFile(path.join(w.dir, 'nested', 'app.ts'), 'nested edits');
    expect(await w.read()).not.toBeNull();
    expect(await w.read({ requireComplete: true })).toBeNull();
  });
  it('does not hide a staged gitlink move behind submodule ignore=all', async () => {
    const w = await checkout();
    w.git('init', '-q', 'nested');
    await writeFile(path.join(w.dir, 'nested', 'app.ts'), 'nested base');
    w.git('-C', 'nested', 'add', '.');
    w.git(
      '-C',
      'nested',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@local',
      'commit',
      '-qm',
      'base',
    );
    await writeFile(
      path.join(w.dir, '.gitmodules'),
      '[submodule "nested"]\n path = nested\n url = ./nested\n',
    );
    w.git('add', '-A');
    w.git('commit', '-qm', 'existing submodule');
    w.git('branch', '-f', 'main', 'HEAD');
    w.git('config', 'submodule.nested.ignore', 'all');
    await writeFile(path.join(w.dir, 'app.ts'), 'pending reviewed changes');
    expect(await w.read({ requireComplete: true })).not.toBeNull();
    await writeFile(path.join(w.dir, 'nested', 'app.ts'), 'nested changed');
    w.git('-C', 'nested', 'add', '.');
    w.git(
      '-C',
      'nested',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@local',
      'commit',
      '-qm',
      'changed',
    );
    expect(w.git('status', '--porcelain').toString()).not.toContain('nested');
    expect(await w.read({ requireComplete: true })).toBeNull();
    w.git('add', '-A');
    expect(w.git('diff', '--cached', '--raw', '--ignore-submodules=none').toString()).toContain(
      '160000',
    );
    w.git('commit', '-qm', 'recorded gitlink change');
    expect(await w.read({ requireComplete: true })).toBeNull();
  });
  it('includes committed DAG changes and dirty edits without changing the real index', async () => {
    const w = await checkout();
    w.git('add', '-A');
    w.git('commit', '-qm', 'DAG merge');
    const before = await w.read();
    const index = w.git('ls-files', '--stage').toString();
    await writeFile(path.join(w.dir, 'app.test.ts'), 'new test');
    const after = await w.read();
    expect(affectedValidationFiles(before, after!)).toEqual(['app.test.ts']);
    expect(w.git('ls-files', '--stage').toString()).toBe(index);
  });

  it('does not revalidate no edits or ignored test artifacts', async () => {
    const w = await checkout();
    const before = await w.read();
    await writeFile(path.join(w.dir, 'ignored-output'), 'test output');
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual([]);
  });

  it('detects modifications, deletions and a reversion to the original tree', async () => {
    const w = await checkout();
    const before = await w.read();
    await writeFile(path.join(w.dir, 'app.ts'), 'fixer edit');
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual(['app.ts']);
    await unlink(path.join(w.dir, 'app.ts'));
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual(['app.ts']);
    await writeFile(path.join(w.dir, 'app.ts'), 'old');
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual(['app.ts']);
  });

  it('detects executable-bit edits and link target edits without following a link', async () => {
    const w = await checkout();
    await symlink('/outside/one', path.join(w.dir, 'link'));
    const before = await w.read();
    await chmod(path.join(w.dir, 'app.ts'), 0o755);
    await unlink(path.join(w.dir, 'link'));
    await symlink('/outside/two', path.join(w.dir, 'link'));
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual(['app.ts', 'link']);
  });

  it('fingerprints a 9 MiB changed file using its size and bounded prefix', async () => {
    const w = await checkout();
    const file = path.join(w.dir, 'large.bin');
    await writeFile(file, Buffer.alloc(9 * 1024 * 1024, 1));
    const before = await w.read();
    expect(before).not.toBeNull();
    expect(before).toHaveProperty('large.bin');
    await writeFile(file, Buffer.alloc(10 * 1024 * 1024, 1));
    expect(affectedValidationFiles(before, (await w.read())!)).toEqual(['large.bin']);
  });

  it('retries one transient git failure before giving up', async () => {
    const w = await checkout();
    const original = changeReads.readChangedFiles;
    const read = vi
      .spyOn(changeReads, 'readChangedFiles')
      .mockResolvedValueOnce(null)
      .mockImplementation(original);
    expect(await w.read()).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns unknown for a failed Git read instead of an empty snapshot', async () => {
    const w = await checkout();
    w.git('branch', '-D', 'main');
    expect(await w.read()).toBeNull();
  });
});

it('snapshot digests bind sorted paths and their content/kind/mode stamps in fixed-size evidence', () => {
  const first = validationSnapshotDigest({ 'b.ts': 'file-stamp', 'a.ts': 'link-stamp' });
  expect(first).toEqual(validationSnapshotDigest({ 'a.ts': 'link-stamp', 'b.ts': 'file-stamp' }));
  expect(first).toMatchObject({
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    incomplete: false,
  });
  const changedSnapshots: Record<string, string>[] = [
    { 'b.ts': 'file-stamp' },
    { 'b.ts': 'file-stamp', 'renamed.ts': 'link-stamp' },
    { 'b.ts': 'file-stamp', 'a.ts': 'different-kind-or-content' },
  ];
  for (const changed of changedSnapshots)
    expect(validationSnapshotDigest(changed)).not.toEqual(first);
  expect(validationSnapshotDigest(null)).toEqual({ sha256: null, incomplete: true });
  expect(validationSnapshotDigest({})).toMatchObject({ incomplete: false });
});
