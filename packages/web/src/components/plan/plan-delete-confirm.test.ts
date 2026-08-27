import { describe, expect, it } from 'vitest';
import { planDeleteConfirmed } from './plan-delete-confirm';

describe('planDeleteConfirmed', () => {
  it('unlocks on the exact name', () => {
    expect(planDeleteConfirmed('redsys', 'redsys')).toBe(true);
  });

  it('forgives whitespace a copy-paste picked up', () => {
    expect(planDeleteConfirmed('  redsys ', 'redsys')).toBe(true);
    expect(planDeleteConfirmed('redsys\n', 'redsys')).toBe(true);
  });

  it('does not unlock on the wrong case', () => {
    // The one control whose purpose is to be hard to satisfy by accident.
    expect(planDeleteConfirmed('RedSys', 'redsys')).toBe(false);
  });

  it('does not unlock on a near miss', () => {
    expect(planDeleteConfirmed('redsy', 'redsys')).toBe(false);
    expect(planDeleteConfirmed('redsys2', 'redsys')).toBe(false);
    expect(planDeleteConfirmed('', 'redsys')).toBe(false);
  });

  it('never unlocks when there is no name to type', () => {
    // Otherwise an empty box would match an unnamed repository.
    expect(planDeleteConfirmed('', '')).toBe(false);
    expect(planDeleteConfirmed('   ', '   ')).toBe(false);
    expect(planDeleteConfirmed('anything', '')).toBe(false);
  });
});
