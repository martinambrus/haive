import { describe, expect, it } from 'vitest';
import { ddevConfigGuidanceLines } from './_retrieval-guidance.js';

describe('ddevConfigGuidanceLines', () => {
  it('emits the rule when the work mentions DDEV', () => {
    const lines = ddevConfigGuidanceLines('Add DDEV to this Drupal site');
    expect(lines.join('\n')).toContain('ddev_version_constraint');
    expect(lines.join('\n')).toContain('>= v1.24.0 < v2.0.0');
  });

  it('matches case-insensitively', () => {
    expect(ddevConfigGuidanceLines('add ddev').length).toBeGreaterThan(0);
    expect(ddevConfigGuidanceLines('Configure DDev locally').length).toBeGreaterThan(0);
  });

  it('stays out of prompts that have nothing to do with DDEV', () => {
    // The lines are pure prompt weight for such a task, and the runtime repair in
    // sandbox/ddev-version-constraint.ts is what actually guarantees the outcome.
    expect(ddevConfigGuidanceLines('Add a logout button to the header')).toEqual([]);
    expect(ddevConfigGuidanceLines('')).toEqual([]);
  });

  it('does not fire on a word that merely contains "ddev"', () => {
    expect(ddevConfigGuidanceLines('refactor the middevice adapter')).toEqual([]);
  });
});
