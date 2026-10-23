import { describe, expect, it } from 'vitest';
import type { PlanSnapshotHealth } from '@/lib/api-client';
import { showsPushAndPull } from './plan-snapshot';

function snapshot(over: Partial<PlanSnapshotHealth> = {}): PlanSnapshotHealth {
  return {
    revision: 1,
    writtenRevision: 1,
    snapshotState: 'written',
    snapshotWritten: true,
    lastError: null,
    filesExist: true,
    gitAvailable: true,
    tracked: true,
    uncommitted: false,
    committed: true,
    pushed: true,
    branch: 'main',
    hasOrigin: true,
    originUrl: 'git@example.com:acme/app.git',
    ...over,
  };
}

describe('showsPushAndPull', () => {
  it('hides them while the snapshot is loading', () => {
    expect(showsPushAndPull(null)).toBe(false);
  });

  it('shows them with an origin', () => {
    expect(showsPushAndPull(snapshot({ hasOrigin: true }))).toBe(true);
  });

  it('hides them when git says there is no origin', () => {
    expect(showsPushAndPull(snapshot({ hasOrigin: false, originUrl: null }))).toBe(false);
  });

  it('shows them when every git read failed', () => {
    expect(
      showsPushAndPull(
        snapshot({
          hasOrigin: null,
          gitAvailable: null,
          tracked: null,
          uncommitted: null,
          originUrl: null,
        }),
      ),
    ).toBe(true);
  });

  it('shows them when only the origin read failed', () => {
    expect(showsPushAndPull(snapshot({ hasOrigin: null, originUrl: null }))).toBe(true);
  });
});
