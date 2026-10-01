import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { admissionKindFromRuntimeMode, classifyRuntime } from './_app-runtime.js';

describe('admissionKindFromRuntimeMode', () => {
  it('maps a classified runtime to the pooled runner it will spawn', () => {
    expect(admissionKindFromRuntimeMode('ddev')).toBe('ddev');
    expect(admissionKindFromRuntimeMode('app-runner')).toBe('app');
  });

  it('claims no slot for a task that spawns no runner', () => {
    // 'none' is the code-only task (no .ddev/config.yaml, no 01a-app-boot row) and 'host' is the
    // legacy on-worker boot. Neither puts a container in the runtime pool, so neither may park
    // behind it — 07/07b/08 sit in every execution path's SPINE and would otherwise queue every
    // plain bug-fix task behind the DDEV limit.
    expect(admissionKindFromRuntimeMode('none')).toBeNull();
    expect(admissionKindFromRuntimeMode('host')).toBeNull();
  });
});

describe('classifyRuntime', () => {
  const USER = '00000000-0000-4000-8000-0000000000a1';
  const REPO = '00000000-0000-4000-8000-0000000000b1';
  const TASK = '00000000-0000-4000-8000-000000000001';
  const ROW = '00000000-0000-4000-8000-0000000000c1';

  let root = '';
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ensureDdevStarted removes a runner whose mounted subpath differs from this one, so an answer
  // naming the repository root takes down the runner that serves the worktree.
  it('classifies the worktree the task column names after a Retry reset the 01 output', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'haive-classify-runtime-'));
    const worktree = path.join(root, '.haive/worktrees/feature-x');
    for (const [dir, name] of [
      [root, 'root-project'],
      [worktree, 'worktree-project'],
    ] as const) {
      await mkdir(path.join(dir, '.ddev'), { recursive: true });
      await writeFile(path.join(dir, '.ddev/config.yaml'), `name: ${name}\n`);
    }
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      worktreePath: worktree,
    });
    fake.insert(schema.taskSteps, {
      id: ROW,
      taskId: TASK,
      stepId: '01-worktree-setup',
      round: 0,
      status: 'waiting_form',
      output: null,
    });

    const spec = await classifyRuntime({
      db: fake.db as unknown as Database,
      taskId: TASK,
      repoPath: root,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    expect(spec).toMatchObject({
      mode: 'ddev',
      workspace: worktree,
      repoSubpath: `${USER}/${REPO}/.haive/worktrees/feature-x`,
      knownUrl: 'https://worktree-project.ddev.site',
    });
  });
});
