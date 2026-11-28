import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  repo: { status: 'ready' } as { status: string },
  taskRow: vi.fn(),
  exec: vi.fn(),
  ensure: vi.fn(),
  handle: vi.fn(),
  workspace: vi.fn(),
  recovery: vi.fn(),
  repoReads: vi.fn(),
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
        findFirst: async () => {
          await h.repoReads();
          return { id: 'row', storagePath: '/repos/u/r', ...h.repo };
        },
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
  probeDdevRecovery: h.recovery,
}));
import { CheckoutUnavailableError } from '@haive/shared/checkout-access';
import {
  interactiveCheckouts,
  withSubpathInteractiveCheckout,
} from '../repo/interactive-checkout.js';
import { RunnerProbeError } from '../sandbox/runner-probe.js';
import { runDdevControl } from './ddev-control-queue.js';

const MSG = new CheckoutUnavailableError().message;
const REFUSAL = { ok: false, output: MSG, error: MSG };
const taskId = randomUUID();
let repositoryId = randomUUID();
let repoSubpath = `${randomUUID()}/${repositoryId}`;
let handle = { container: `haive-ddev-${randomUUID()}`, projectDir: `/repos/${repoSubpath}` };
const restart = () => runDdevControl({ taskId, action: 'restart' } as never);
const releases: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  repositoryId = randomUUID();
  repoSubpath = `${randomUUID()}/${repositoryId}`;
  h.repo.status = 'ready';
  h.taskRow.mockResolvedValue({ repositoryId });
  h.workspace.mockResolvedValue({ repoSubpath });
  handle = { container: `haive-ddev-${randomUUID()}`, projectDir: `/repos/${repoSubpath}` };
  h.handle.mockReturnValue(handle);
  h.recovery.mockResolvedValue('cold-boot');
  h.repoReads.mockResolvedValue(undefined);
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

  it('cold boots a failed restart when the recovery probe says cold-boot, and says so', async () => {
    h.exec.mockResolvedValue({ exitCode: 1, output: 'gone' });
    h.recovery.mockResolvedValue('cold-boot');
    const result = await restart();
    expect(result).toEqual({
      ok: true,
      output: expect.stringMatching(
        /^gone\n\[ddev restart failed \(exit 1\); .*rebuilt by a cold boot\]$/,
      ),
    });
    expect(result.output).not.toContain('started in place');
    expect(h.recovery).toHaveBeenCalledExactlyOnceWith(handle, repoSubpath);
    expect(h.ensure).toHaveBeenCalledExactlyOnceWith(taskId, repoSubpath, {
      onProgress: expect.any(Function),
    });
  });

  it('starts a failed restart in place when the recovery probe says warm-start, and says so', async () => {
    h.exec.mockResolvedValue({ exitCode: 75, output: 'port busy' });
    h.recovery.mockResolvedValue('warm-start');
    const result = await restart();
    expect(result).toEqual({
      ok: true,
      output: expect.stringMatching(
        /^port busy\n\[ddev restart failed \(exit 75\); .*started in place\]$/,
      ),
    });
    expect(result.output).not.toContain('cold boot');
    expect(h.recovery).toHaveBeenCalledExactlyOnceWith(handle, repoSubpath);
    expect(h.ensure).toHaveBeenCalledExactlyOnceWith(taskId, repoSubpath, {
      onProgress: expect.any(Function),
    });
  });

  it.each(['cold-boot', 'warm-start'])(
    'keeps the note of a %s recovery when the restart output is long',
    async (recovery) => {
      h.exec.mockResolvedValue({ exitCode: 1, output: 'x'.repeat(9000) });
      h.recovery.mockResolvedValue(recovery);
      const result = await restart();
      expect(result.ok).toBe(true);
      expect(result.output).toHaveLength(8000);
      expect(result.output).toMatch(/\[ddev restart failed \(exit 1\); .*\]$/);
    },
  );

  it.each([1, 75, 124])(
    'reports a failed restart whose project is still serving (exit %i) and recovers nothing',
    async (exitCode) => {
      const output = 'x'.repeat(9000) + 'tail-marker';
      h.exec.mockResolvedValue({ exitCode, output });
      h.recovery.mockResolvedValue('reuse');
      const result = await restart();
      expect(result).toEqual({
        ok: false,
        output: output.slice(-8000),
        error: expect.stringMatching(
          new RegExp(`^ddev restart failed \\(exit ${exitCode}\\); the project is still serving`),
        ),
      });
      expect(h.recovery).toHaveBeenCalledExactlyOnceWith(handle, repoSubpath);
      expect(h.ensure).not.toHaveBeenCalled();
    },
  );

  it.each([['Error response from daemon: No such container: x'], ['unrelated text']])(
    'does not key the decision on wording (%s)',
    async (output) => {
      h.exec.mockResolvedValue({ exitCode: 1, output });
      h.recovery.mockResolvedValue('reuse');
      await expect(restart()).resolves.toMatchObject({ ok: false, output });
      expect(h.ensure).not.toHaveBeenCalled();
      h.recovery.mockResolvedValue('warm-start');
      await expect(restart()).resolves.toMatchObject({ ok: true });
      expect(h.ensure).toHaveBeenCalledOnce();
    },
  );

  it('does not recover when the recovery probe has no answer', async () => {
    const error = new RunnerProbeError(handle.container, new Error('docker down'));
    h.exec.mockResolvedValue({ exitCode: 1, output: 'down' });
    h.recovery.mockRejectedValue(error);
    await expect(restart()).resolves.toEqual({ ok: false, output: '', error: error.message });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it.each(['cold-boot', 'warm-start'])(
    'answers the failure, not a success, when the %s recovery throws',
    async (recovery) => {
      h.exec.mockResolvedValue({ exitCode: 1, output: 'down' });
      h.recovery.mockResolvedValue(recovery);
      h.ensure.mockRejectedValue(new Error('ddev start failed: boom'));
      await expect(restart()).resolves.toEqual({
        ok: false,
        output: '',
        error: 'ddev start failed: boom',
      });
    },
  );

  it.each(['cold-boot', 'warm-start', 'reuse'])(
    'the refusal wins over the probe answer %s, and nothing is probed',
    async (recovery) => {
      h.recovery.mockResolvedValue(recovery);
      h.exec.mockImplementation(async () => {
        h.repo.status = 'cloning';
        return { exitCode: 1, output: 'down' };
      });
      await expect(restart()).resolves.toEqual(REFUSAL);
      expect(h.recovery).not.toHaveBeenCalled();
      expect(h.ensure).not.toHaveBeenCalled();
    },
  );

  it('never probes the runner after a successful restart', async () => {
    h.exec.mockResolvedValue({ exitCode: 0, output: 'restarted' });
    await expect(restart()).resolves.toEqual({ ok: true, output: 'restarted' });
    expect(h.recovery).not.toHaveBeenCalled();
  });

  it('answers a database error at the gate without its bound values', async () => {
    const secret = randomBytes(16).toString('hex');
    const dbError = Object.assign(new Error(`select failed for ${secret}`), { params: [secret] });
    h.repoReads.mockResolvedValueOnce(undefined).mockRejectedValueOnce(dbError);
    const result = await restart();
    expect(result).toEqual({ ok: false, output: '', error: 'Database operation failed' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(h.exec).not.toHaveBeenCalled();
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
