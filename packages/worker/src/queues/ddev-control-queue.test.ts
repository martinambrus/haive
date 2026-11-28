import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  repo: { status: 'ready' } as { status: string },
  taskRow: vi.fn(),
  exec: vi.fn(),
  ensure: vi.fn(),
  handle: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    on() {}
  },
}));
vi.mock('../redis.js', () => ({ getBullRedis: () => ({}), getRedis: () => ({}) }));
vi.mock('./safe-processor.js', () => ({ safeProcessor: (fn: unknown) => fn }));
vi.mock('../db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: h.taskRow },
      repositories: {
        findFirst: async () => ({ id: 'row', storagePath: '/repos/u/r', ...h.repo }),
      },
    },
  }),
}));
vi.mock('../step-engine/steps/workflow/_task-meta.js', () => ({
  resolveDdevWorkspace: h.workspace,
}));
vi.mock('../sandbox/ddev-runner.js', () => ({
  runnerHandleForTask: h.handle,
  ddevExec: h.exec,
  ensureDdevStarted: h.ensure,
}));
import { CheckoutUnavailableError } from '@haive/shared/checkout-access';
import {
  interactiveCheckouts,
  withSubpathInteractiveCheckout,
} from '../repo/interactive-checkout.js';
import { runDdevControl } from './ddev-control-queue.js';

const MSG = new CheckoutUnavailableError().message;
const REFUSAL = { ok: false, output: MSG, error: MSG };
const taskId = randomUUID();
let repositoryId = randomUUID();
let repoSubpath = `${randomUUID()}/${repositoryId}`;
const restart = () => runDdevControl({ taskId, action: 'restart' } as never);
const releases: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  repositoryId = randomUUID();
  repoSubpath = `${randomUUID()}/${repositoryId}`;
  h.repo.status = 'ready';
  h.taskRow.mockResolvedValue({ repositoryId });
  h.workspace.mockResolvedValue({ repoSubpath });
  h.handle.mockReturnValue('handle');
  h.exec.mockResolvedValue({ exitCode: 0, output: 'restarted' });
  h.ensure.mockResolvedValue(undefined);
});
afterEach(() => {
  while (releases.length) releases.pop()!();
});

describe('ddev restart gate', () => {
  it.each(['cloning', 'error'])('refuses restart while the repository is %s', async (status) => {
    h.repo.status = status;
    h.exec.mockResolvedValue({ exitCode: 1, output: 'down' });
    await expect(restart()).resolves.toEqual(REFUSAL);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('refuses while the process barrier is suspended, allows after release', async () => {
    const release = await interactiveCheckouts.suspend(repositoryId, async () => {});
    releases.push(release);
    await expect(restart()).resolves.toEqual(REFUSAL);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
    release();
    await expect(restart()).resolves.toMatchObject({ ok: true });
    expect(h.exec).toHaveBeenCalledOnce();
  });

  it('does not cold boot when the repository became unavailable during the exec', async () => {
    h.exec.mockImplementation(async () => {
      h.repo.status = 'cloning';
      return { exitCode: 1, output: 'down' };
    });
    await expect(restart()).resolves.toEqual(REFUSAL);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('does not cold boot, and does not deadlock, when the barrier suspends during the exec', async () => {
    let suspended: Promise<() => void> | undefined;
    h.exec.mockImplementation(async () => {
      suspended = interactiveCheckouts
        .suspend(repositoryId, async () => {})
        .then((release) => {
          releases.push(release);
          return release;
        });
      return { exitCode: 1, output: 'down' };
    });
    await expect(restart()).resolves.toEqual(REFUSAL);
    expect(h.ensure).not.toHaveBeenCalled();
    const outcome = await Promise.race([
      suspended!.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(outcome).toBe('settled');
  });

  it('restarts a ready repository in place', async () => {
    await expect(restart()).resolves.toEqual({ ok: true, output: 'restarted' });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('cold boots a ready repository whose in-place restart failed', async () => {
    h.exec.mockResolvedValue({ exitCode: 1, output: 'gone' });
    const result = await restart();
    expect(result.ok).toBe(true);
    expect(result.output).toContain('recovered via cold boot');
    expect(h.ensure).toHaveBeenCalledOnce();
    expect(h.ensure).toHaveBeenCalledWith(taskId, repoSubpath, {
      onProgress: expect.any(Function),
    });
  });

  it('lets the cold boot open the checkout again without deadlock', async () => {
    h.exec.mockResolvedValue({ exitCode: 1, output: 'gone' });
    h.ensure.mockImplementation(() => withSubpathInteractiveCheckout(repoSubpath, async () => {}));
    await expect(restart()).resolves.toMatchObject({ ok: true });
    expect(h.ensure).toHaveBeenCalledOnce();
  });
});

describe('ungated actions', () => {
  beforeEach(() => {
    h.repo.status = 'cloning';
  });
  it('status still execs', async () => {
    h.exec.mockResolvedValue({ exitCode: 0, output: '{}' });
    await expect(runDdevControl({ taskId, action: 'status' } as never)).resolves.toEqual({
      ok: true,
      output: '{}',
    });
    expect(h.exec).toHaveBeenCalledOnce();
  });
  it('logs still execs', async () => {
    h.exec.mockResolvedValue({ exitCode: 0, output: 'a\nb' });
    await expect(runDdevControl({ taskId, action: 'logs' } as never)).resolves.toEqual({
      ok: true,
      output: 'a\nb',
    });
    expect(h.exec).toHaveBeenCalledOnce();
  });
  it('rejects an unknown action', async () => {
    await expect(runDdevControl({ taskId, action: 'nope' } as never)).resolves.toMatchObject({
      ok: false,
      error: 'unknown action: nope',
    });
  });
});
