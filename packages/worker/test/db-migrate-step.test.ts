import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';

// The raw handle is what runnerHandleForTask rebuilds from the task id alone, with no check that
// the runner exists. The ensured handle is what ensureDdevWithProgress returns once it is up.
const { RAW_HANDLE, ENSURED_HANDLE } = vi.hoisted(() => ({
  RAW_HANDLE: { container: 'haive-ddev-x', projectDir: '/repos/sub' },
  ENSURED_HANDLE: { container: 'haive-ddev-ensured', projectDir: '/repos/sub' },
}));

// The step reaches the DDEV runner only through these helpers; mock the whole
// sandbox module so apply() runs without a live container.
vi.mock('../src/sandbox/ddev-runner.js', () => ({
  runnerHandleForTask: vi.fn(() => RAW_HANDLE),
  ddevExec: vi.fn(),
  ddevSnapshot: vi.fn(async () => ({ exitCode: 0, output: '' })),
  ddevMigratedSnapshotName: vi.fn(() => 'migrated-snap'),
}));

// withDdevProgress just wraps a streaming call; invoke its callback with a noop
// onLine so the real ddevExec mock (below) supplies the result.
vi.mock('../src/step-engine/steps/workflow/_app-runtime.js', () => ({
  withDdevProgress: vi.fn(
    async (_ctx: unknown, _msg: string, fn: (onLine: (l: string) => void) => Promise<unknown>) =>
      fn(() => undefined),
  ),
  ensureDdevWithProgress: vi.fn(async () => ENSURED_HANDLE),
}));

import { dbMigrateStep } from '../src/step-engine/steps/workflow/06a-db-migrate.js';
import { ddevExec, ddevSnapshot } from '../src/sandbox/ddev-runner.js';
import { ensureDdevWithProgress } from '../src/step-engine/steps/workflow/_app-runtime.js';

const DRUSH_PROBE = 'exec drush status --field=db-status';

const ctx = {
  taskId: 'task-1',
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
} as unknown as StepContext;

function applyArgs(detected: unknown, formValues: Record<string, unknown>) {
  return { detected, formValues, iteration: 0, previousIterations: [] } as never;
}

const drupalDetect = {
  framework: 'drupal' as const,
  migrationCommand: 'drush updatedb -y',
  repoSubpath: 'sub',
};

beforeEach(() => {
  vi.mocked(ensureDdevWithProgress).mockReset().mockResolvedValue(ENSURED_HANDLE);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('06a-db-migrate apply', () => {
  it('skips (not fails) when Drupal has no live DB connection', async () => {
    // Pre-flight probe: uninstalled site -> drush prints an empty db-status.
    vi.mocked(ddevExec).mockReset().mockResolvedValue({ exitCode: 0, output: '' });

    const out = await dbMigrateStep.apply(
      ctx,
      applyArgs(drupalDetect, { runMigration: true, migrationCommand: 'drush updatedb -y' }),
    );

    expect(out).toMatchObject({ ran: false, skipped: true, passed: true });
    // Only the probe ran; the opaque-failing `drush updatedb` was never invoked.
    expect(ddevExec).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ddevExec).mock.calls[0]?.[1]).toBe(DRUSH_PROBE);
  });

  it('runs the migration when Drupal reports a live DB connection', async () => {
    vi.mocked(ddevExec)
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, output: 'Connected\n' }) // probe
      .mockResolvedValueOnce({ exitCode: 0, output: 'No pending updates.' }); // updatedb

    const out = await dbMigrateStep.apply(
      ctx,
      applyArgs(drupalDetect, { runMigration: true, migrationCommand: 'drush updatedb -y' }),
    );

    expect(out).toMatchObject({ ran: true, skipped: false, passed: true });
    expect(vi.mocked(ddevExec).mock.calls[1]?.[1]).toBe('exec drush updatedb -y');
  });

  it('does not probe for non-Drupal frameworks', async () => {
    const laravelDetect = {
      framework: 'laravel' as const,
      migrationCommand: 'php artisan migrate --force',
      repoSubpath: 'sub',
    };
    vi.mocked(ddevExec)
      .mockReset()
      .mockResolvedValue({ exitCode: 0, output: 'Nothing to migrate.' });

    const out = await dbMigrateStep.apply(
      ctx,
      applyArgs(laravelDetect, {
        runMigration: true,
        migrationCommand: 'php artisan migrate --force',
      }),
    );

    expect(out).toMatchObject({ ran: true, skipped: false });
    expect(
      vi.mocked(ddevExec).mock.calls.every((c) => !String(c[1]).includes('drush status')),
    ).toBe(true);
  });
});

describe('06a-db-migrate apply: the runner is ensured before anything execs into it', () => {
  const laravelDetect = {
    framework: 'laravel' as const,
    migrationCommand: 'php artisan migrate --force',
    repoSubpath: 'sub',
  };
  const frameworks = [
    ['drupal', drupalDetect],
    ['laravel', laravelDetect],
  ] as const;

  const run = (detect: typeof drupalDetect | typeof laravelDetect) =>
    dbMigrateStep.apply(
      ctx,
      applyArgs(detect, { runMigration: true, migrationCommand: detect.migrationCommand }),
    );

  function liveRunner() {
    vi.mocked(ddevExec)
      .mockReset()
      .mockImplementation(async (_handle, args) =>
        args === DRUSH_PROBE
          ? { exitCode: 0, output: 'Connected\n' }
          : { exitCode: 0, output: 'Nothing to migrate.' },
      );
  }

  // Only the ensured handle names a runner that is up; the raw one names the runner that was reaped.
  function runnerGoneUntilEnsured() {
    vi.mocked(ddevExec)
      .mockReset()
      .mockImplementation(async (handle, args) =>
        handle.container !== ENSURED_HANDLE.container
          ? {
              exitCode: 1,
              output: `Error response from daemon: No such container: ${handle.container}`,
            }
          : args === DRUSH_PROBE
            ? { exitCode: 0, output: 'Connected\n' }
            : { exitCode: 0, output: 'Nothing to migrate.' },
      );
  }

  it.each(frameworks)(
    '%s: ensures the detected subpath before the first exec',
    async (_n, detect) => {
      liveRunner();

      await run(detect);

      expect(ensureDdevWithProgress).toHaveBeenCalledTimes(1);
      expect(ensureDdevWithProgress).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1' }),
        'sub',
      );
      const ensureAt = vi.mocked(ensureDdevWithProgress).mock.invocationCallOrder[0]!;
      const firstExecAt = vi.mocked(ddevExec).mock.invocationCallOrder[0]!;
      expect(ensureAt, 'the first exec ran before the runner was ensured').toBeLessThan(
        firstExecAt,
      );
    },
  );

  it.each(frameworks)(
    '%s: every exec runs on the handle the ensure returned',
    async (_n, detect) => {
      liveRunner();

      await run(detect);

      const containers = vi.mocked(ddevExec).mock.calls.map((c) => c[0].container);
      expect(containers.length).toBeGreaterThan(0);
      expect(new Set(containers)).toEqual(new Set([ENSURED_HANDLE.container]));
    },
  );

  it.each(frameworks)(
    '%s: the migrated snapshot is taken on the handle the ensure returned',
    async (_n, detect) => {
      liveRunner();

      await run(detect);

      expect(vi.mocked(ddevSnapshot).mock.calls.map((c) => c[0].container)).toEqual([
        ENSURED_HANDLE.container,
      ]);
    },
  );

  it.each(frameworks)(
    '%s: a runner that is gone is brought back by the ensure, not read as an uninstalled site',
    async (_n, detect) => {
      runnerGoneUntilEnsured();

      await expect(run(detect)).resolves.toMatchObject({
        ran: true,
        skipped: false,
        passed: true,
      });
    },
  );

  it.each(frameworks)(
    '%s: a failed ensure fails the step before anything execs',
    async (_n, detect) => {
      vi.mocked(ensureDdevWithProgress).mockRejectedValueOnce(
        new Error('DDEV cannot start: the ensure failed'),
      );
      vi.mocked(ddevExec).mockReset().mockResolvedValue({
        exitCode: 1,
        output: 'Error response from daemon: No such container: haive-ddev-x',
      });

      await expect(run(detect)).rejects.toThrow(/the ensure failed/);
      expect(ddevExec).not.toHaveBeenCalled();
    },
  );

  it.each(frameworks)(
    '%s: a cancel from the ensure reaches the runner as that cancel',
    async (_n, detect) => {
      const cancel = new TaskCancelledError('stopped from the task page');
      vi.mocked(ensureDdevWithProgress).mockRejectedValueOnce(cancel);
      liveRunner();

      await expect(run(detect)).rejects.toBe(cancel);
      expect(ddevExec).not.toHaveBeenCalled();
    },
  );

  it('does not ensure the runner when the migration is skipped', async () => {
    liveRunner();

    const out = await dbMigrateStep.apply(
      ctx,
      applyArgs(drupalDetect, { runMigration: false, migrationCommand: 'drush updatedb -y' }),
    );

    expect(out).toMatchObject({ ran: false, skipped: true, passed: true });
    expect(ensureDdevWithProgress).not.toHaveBeenCalled();
    expect(ddevExec).not.toHaveBeenCalled();
  });
});
