import { describe, expect, it } from 'vitest';
import {
  describeEnforceSpec,
  globsFromLines,
  holdsApproval,
  houseRuleBadge,
  lapsesOnEdit,
} from './house-rules';

describe('houseRuleBadge', () => {
  it('names the mode of an enforced rule', () => {
    expect(houseRuleBadge({ state: 'enforced', mode: 'files', globs: ['a/**'] })?.label).toBe(
      'Enforced · files',
    );
    expect(houseRuleBadge({ state: 'enforced', mode: 'always' })?.label).toBe('Enforced · always');
  });

  it('gives each lapse its reason', () => {
    expect(houseRuleBadge({ state: 'edited' })?.label).toBe('Lapsed · edited');
    expect(houseRuleBadge({ state: 'not_active' })?.label).toBe('Lapsed · not active');
    expect(houseRuleBadge({ state: 'superseded' })?.label).toBe('Superseded');
    expect(houseRuleBadge({ state: 'cleared' })?.label).toBe('Not enforced');
  });

  it('calls both states that resume on their own paused', () => {
    expect(houseRuleBadge({ state: 'switched_off' })?.label).toBe('Paused');
    expect(houseRuleBadge({ state: 'other_namespace' })?.label).toBe('Paused');
  });

  it('shows nothing for an entry that was never enforced or an older api row', () => {
    expect(houseRuleBadge({ state: 'none' })).toBeNull();
    expect(houseRuleBadge(undefined)).toBeNull();
  });
});

describe('holdsApproval', () => {
  it('is true while the approval is still on the row', () => {
    for (const state of ['enforced', 'edited', 'not_active', 'switched_off', 'other_namespace']) {
      expect(holdsApproval({ state } as never)).toBe(true);
    }
  });

  it('is false once it is gone or never existed', () => {
    for (const state of ['none', 'cleared', 'superseded']) {
      expect(holdsApproval({ state } as never)).toBe(false);
    }
    expect(holdsApproval(undefined)).toBe(false);
  });
});

describe('lapsesOnEdit', () => {
  it('is true only while the approval is live', () => {
    expect(lapsesOnEdit({ state: 'enforced', mode: 'always' })).toBe(true);
    expect(lapsesOnEdit({ state: 'switched_off' })).toBe(true);
    expect(lapsesOnEdit({ state: 'edited' })).toBe(false);
    expect(lapsesOnEdit({ state: 'none' })).toBe(false);
    expect(lapsesOnEdit(undefined)).toBe(false);
  });
});

describe('globsFromLines', () => {
  it('keeps a brace glob whole', () => {
    expect(globsFromLines('src/**/*.{twig,css}\n\n  docs/** \r\n')).toEqual([
      'src/**/*.{twig,css}',
      'docs/**',
    ]);
  });
});

describe('describeEnforceSpec', () => {
  it('reads back the last settings', () => {
    expect(describeEnforceSpec({ mode: 'files', globs: ['a', 'b'] })).toBe('files: a, b');
    expect(describeEnforceSpec({ mode: 'always' })).toBe('always');
    expect(describeEnforceSpec(null)).toBe('none');
  });
});
