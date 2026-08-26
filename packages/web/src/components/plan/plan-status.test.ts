import { describe, it, expect } from 'vitest';
import {
  PLAN_KINDS,
  PLAN_STATUSES,
  countLabel,
  isRolledUp,
  kindLabel,
  statusBadge,
  statusDot,
  statusLabel,
} from './plan-status';

describe('plan-status', () => {
  it('spells and colours every status', () => {
    for (const s of PLAN_STATUSES) {
      expect(statusLabel(s)).toBeTruthy();
      expect(statusDot(s)).toMatch(/^bg-/);
      expect(statusBadge(s)).toBeTruthy();
    }
  });

  it('names every kind', () => {
    for (const k of PLAN_KINDS) expect(kindLabel(k)).toBeTruthy();
  });

  it('offers every kind except decision, but still names legacy decision nodes', () => {
    // `decision` is agent-written metadata a human never needs to pick; it is
    // absent from the picker so legacy nodes can still be re-labelled away
    // from it, and kindLabel must keep resolving it for anything that renders.
    expect(PLAN_KINDS).toEqual(['component', 'research', 'external']);
    expect(PLAN_KINDS).not.toContain('decision');
    expect(kindLabel('decision')).toBe('Decision');
  });

  it('keeps done the only green', () => {
    const green = PLAN_STATUSES.filter((s) => statusBadge(s) === 'success');
    expect(green).toEqual(['done']);
  });

  it('does not colour a human blocker as a failure', () => {
    // Red is reserved for failure so it keeps meaning failure; a blocker is
    // something waiting on a person.
    expect(statusBadge('blocked_human')).toBe('warning');
    expect(PLAN_STATUSES.filter((s) => statusBadge(s) === 'error')).toEqual([]);
  });

  it('does not colour not_applicable as complete', () => {
    // It must not prevent an ancestor going green (that is the roll-up's job),
    // but it must not LOOK achieved either.
    expect(statusBadge('not_applicable')).toBe('default');
    expect(statusDot('not_applicable')).not.toBe(statusDot('done'));
  });

  it('shows direct and total separately', () => {
    expect(countLabel(3, 412)).toBe('3 / 412');
  });

  it('detects when the roll-up overrode the node own status', () => {
    expect(isRolledUp('done', 'blocked_human')).toBe(true);
    expect(isRolledUp('todo', 'todo')).toBe(false);
  });
});
