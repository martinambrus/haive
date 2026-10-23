import { describe, expect, it } from 'vitest';
import type { PlanSnapshotHealth } from '@/lib/api-client';
import { showsPushAndPull, snapshotStatus } from './plan-snapshot';

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

describe('snapshotStatus', () => {
  const unknown = { committed: false, uncommitted: null, tracked: true };
  it.each([
    ['loading', null, 'Checking snapshot…', 'warn'],
    ['error', snapshot({ lastError: 'boom', committed: true }), 'Snapshot error', 'error'],
    [
      'missing',
      snapshot({ snapshotState: 'missing', committed: false }),
      'Snapshot missing',
      'warn',
    ],
    [
      'updating',
      snapshot({ snapshotWritten: false, committed: false }),
      'Snapshot updating…',
      'warn',
    ],
    ['updating but committed', snapshot({ snapshotWritten: false }), 'Snapshot updating…', 'good'],
    ['untracked', snapshot({ committed: false, tracked: false }), 'Not committed', 'warn'],
    [
      'uncommitted changes',
      snapshot({ committed: false, uncommitted: true }),
      'Not committed',
      'warn',
    ],
    [
      'tracked read failed',
      snapshot({ committed: false, tracked: null }),
      'Commit state unknown',
      'neutral',
    ],
    ['status read failed', snapshot({ ...unknown }), 'Commit state unknown', 'neutral'],
    [
      'every git read failed',
      snapshot({ committed: false, gitAvailable: null, tracked: null, uncommitted: null }),
      'Commit state unknown',
      'neutral',
    ],
    ['pushed', snapshot({ pushed: true }), 'Committed and pushed', 'good'],
    ['ahead', snapshot({ pushed: false }), 'Committed, not pushed', 'good'],
    ['no upstream', snapshot({ pushed: null }), 'Committed', 'good'],
  ])('%s', (_name, input, label, tone) => {
    expect(snapshotStatus(input)).toEqual({ label, tone });
  });
});
