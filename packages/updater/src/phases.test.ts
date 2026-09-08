import { describe, expect, it } from 'vitest';
import {
  decideResume,
  isPastPointOfNoReturn,
  nextPhase,
  UPGRADE_PHASES,
  type UpgradePhase,
} from './phases.js';

describe('decideResume', () => {
  // Everything before `commit` is reversible by construction, and each for its own reason — so
  // each is asserted rather than covered by a loop that would pass if the pivot moved.
  it('reverses anything that only applied holds or is repeatable', () => {
    for (const phase of ['preflight', 'draining', 'maintenance', 'snapshot'] as UpgradePhase[]) {
      expect(decideResume(phase).action).toBe('reverse');
    }
  });

  // The one people get wrong: a half-applied migration set is NOT reversed by undoing migrations.
  // They are forward-only and additive, so the previous images still run against whatever landed;
  // reversing means restoring the previous tag.
  it('reverses a half-finished migrate without undoing migrations', () => {
    const d = decideResume('migrate');
    expect(d.action).toBe('reverse');
    expect(d.reason).toMatch(/additive/);
  });

  it('reverses at verify, because a gate that did not finish did not pass', () => {
    expect(decideResume('verify').action).toBe('reverse');
  });

  // The pivot. Past here the destructive data migrations may have run, and they delete rows in a
  // database the snapshot does not cover.
  it('goes FORWARD at commit', () => {
    const d = decideResume('commit');
    expect(d.action).toBe('forward');
    expect(d.reason).toMatch(/deleted|destructive/);
  });

  it('has exactly one point of no return, and it is the last phase', () => {
    const forward = UPGRADE_PHASES.filter(isPastPointOfNoReturn);
    expect(forward).toEqual(['commit']);
  });

  it('always gives a reason, since an operator reads this in a log line', () => {
    for (const phase of UPGRADE_PHASES) {
      expect(decideResume(phase).reason.length).toBeGreaterThan(20);
    }
  });
});

describe('nextPhase', () => {
  it('walks the sequence and stops', () => {
    expect(nextPhase('preflight')).toBe('draining');
    expect(nextPhase('verify')).toBe('commit');
    expect(nextPhase('commit')).toBeNull();
  });

  // The order is the safety argument, so a reorder must break a test rather than pass quietly.
  it('is the documented order', () => {
    expect([...UPGRADE_PHASES]).toEqual([
      'preflight',
      'draining',
      'maintenance',
      'snapshot',
      'migrate',
      'verify',
      'commit',
    ]);
  });
});
