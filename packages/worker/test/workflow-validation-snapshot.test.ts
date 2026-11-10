import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  affectedValidationFiles,
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
  const read = () =>
    readValidationSnapshot({
      db: fake.db as unknown as Database,
      taskId: '00000000-0000-4000-8000-000000000001',
    });
  return { dir, git, read };
}

describe('the final changes affected since validation', () => {
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
