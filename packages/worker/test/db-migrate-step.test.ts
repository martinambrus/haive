import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';

// The step reaches the DDEV runner only through these helpers; mock the whole
// sandbox module so apply() runs without a live container.
vi.mock('../src/sandbox/ddev-runner.js', () => ({
  runnerHandleForTask: vi.fn(() => ({ container: 'haive-ddev-x', projectDir: '/repos/sub' })),
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
}));

import { dbMigrateStep } from '../src/step-engine/steps/workflow/06a-db-migrate.js';
import { ddevExec } from '../src/sandbox/ddev-runner.js';

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
    expect(vi.mocked(ddevExec).mock.calls[0][1]).toBe(DRUSH_PROBE);
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
    expect(vi.mocked(ddevExec).mock.calls[1][1]).toBe('exec drush updatedb -y');
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
