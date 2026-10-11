import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ddevExec: vi.fn(),
  ddevRunnerRunning: vi.fn(),
  ddevProjectServing: vi.fn(),
  runStepCommandInSandbox: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: m.exec }) };
});

vi.mock('../../../sandbox/step-command.js', () => ({
  runStepCommandInSandbox: m.runStepCommandInSandbox,
}));

vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: async () => ({ files: [], total: 0, truncated: false }),
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevExec: m.ddevExec,
  ddevRunnerRunning: m.ddevRunnerRunning,
  ddevProjectServing: m.ddevProjectServing,
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { testManagementStep } from './08b-test-management.js';

const TASK = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const REPO = 'cccccccc-0000-4000-8000-000000000001';
// A directory name only the repository chooses.
const ROOT = "sub dir;echo 'x' $(id)";

describe('08b: the directory the pre-flight probe moves the runner into', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    m.ddevExec.mockReset().mockResolvedValue({ exitCode: 0, output: 'listed' });
    m.ddevRunnerRunning.mockReset().mockResolvedValue(true);
    m.ddevProjectServing.mockReset().mockResolvedValue(true);
    m.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    m.runStepCommandInSandbox.mockReset().mockResolvedValue({ ran: true, exitCode: 1, output: '' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** The step's own detect() for a repository whose playwright project sits in `ROOT`. */
  async function detect(ddev = true): Promise<void> {
    vi.spyOn(configService, 'getBoolean').mockImplementation(
      async (key: string) => key === CONFIG_KEYS.TEST_PREFLIGHT_ENABLED,
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-08b-preflight-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'test-playwright'));
    if (ddev) {
      await mkdir(path.join(dir, '.ddev'));
      await writeFile(path.join(dir, '.ddev', 'config.yaml'), '');
    }
    await mkdir(path.join(dir, ROOT, 'tests'), { recursive: true });
    await writeFile(path.join(dir, ROOT, 'playwright.config.ts'), '');
    await writeFile(path.join(dir, ROOT, '.env.sample'), '');
    await writeFile(path.join(dir, ROOT, 'tests', 'a.spec.ts'), '');
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskDagIssues: schema.taskDagIssues,
    });
    fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO, title: 'T' });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '01-worktree-setup',
      round: 0,
      output: { worktreePath: dir },
    });
    const ctx = {
      db: fake.db,
      taskId: TASK,
      repoPath: dir,
      workspacePath: dir,
      sandboxWorkdir: '/ws',
      logger: { info: vi.fn(), warn: vi.fn() },
      emitProgress: vi.fn(async () => {}),
    } as never;
    await testManagementStep.detect!(ctx);
  }

  it('reaches the runner as one word, however the repository named it', async () => {
    await detect();
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    const sent = m.ddevExec.mock.calls[0]![1] as string;
    const nul = String.fromCharCode(0);
    const out = execFileSync('bash', ['-c', `printf '%s\\0' ${sent}`], { encoding: 'utf8' });
    expect(out.split(nul).slice(0, -1)).toEqual([
      'exec',
      '-d',
      `/var/www/html/${ROOT}`,
      'npx',
      'playwright',
      'test',
      '--list',
    ]);
  });

  it('starts no sandbox and waits for no slot when the probe would run on the host side', async () => {
    await detect(false);
    expect(m.runStepCommandInSandbox).not.toHaveBeenCalled();
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.ddevExec).not.toHaveBeenCalled();
  });

  // `ddev exec` against a stopped project starts it, which detect() must never wait on.
  it('does not probe a runner whose DDEV project is not serving', async () => {
    m.ddevProjectServing.mockResolvedValue(false);
    await detect();
    expect(m.ddevExec).not.toHaveBeenCalled();
  });
});
