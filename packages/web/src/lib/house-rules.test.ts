import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GlobalKbEnforcementState, GlobalKbEntry } from './api-client';
import {
  carriesLiveApproval,
  describeEnforceSpec,
  globsFromLines,
  houseRuleBadge,
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

describe('carriesLiveApproval', () => {
  const STATES: Array<GlobalKbEnforcementState['state']> = [
    'none',
    'enforced',
    'edited',
    'not_active',
    'superseded',
    'cleared',
    'other_namespace',
    'switched_off',
  ];
  const entryIn = (state: GlobalKbEnforcementState['state'], enforcedHash?: string | null) =>
    ({ enforcementState: { state }, enforcedHash }) as GlobalKbEntry;

  it('is true for an entry of another namespace that holds a hash', () => {
    expect(carriesLiveApproval(entryIn('other_namespace', 'hr1:abc'))).toBe(true);
  });

  it('is false for an entry of another namespace that holds none', () => {
    expect(carriesLiveApproval(entryIn('other_namespace', null))).toBe(false);
  });

  it('is true while the row holds a hash, whichever state it reads', () => {
    for (const state of STATES) expect(carriesLiveApproval(entryIn(state, 'hr1:abc'))).toBe(true);
  });

  it('is false once the hash is gone, whichever state it reads', () => {
    for (const state of STATES) expect(carriesLiveApproval(entryIn(state, null))).toBe(false);
  });

  it('is false for a row that carries no hash field, as from an older api', () => {
    expect(carriesLiveApproval(entryIn('enforced'))).toBe(false);
    expect(carriesLiveApproval({} as GlobalKbEntry)).toBe(false);
  });
});

describe('the global KB page', () => {
  const page = readFileSync(
    new URL('../app/(app)/settings/global-kb/page.tsx', import.meta.url),
    'utf8',
  );
  const positions = (needle: string): number[] => {
    const found: number[] = [];
    for (let at = page.indexOf(needle); at !== -1; at = page.indexOf(needle, at + 1)) {
      found.push(at);
    }
    return found;
  };

  it.each([
    [
      'the scope, description and body editors',
      'This entry carries an admin&apos;s approval as a house rule.',
      3,
    ],
    ['the archive confirmation', 'Archiving ends that approval', 1],
    ['the delete confirmation', 'deleting it ends that approval', 1],
    ['the activate confirmation', 'Activating archives it and ends that approval', 1],
  ])('warns on %s only for an entry that carriesLiveApproval', (_site, message, sites) => {
    const warnings = positions(message);
    expect(warnings).toHaveLength(sites);
    for (const at of warnings) {
      const gate = page.lastIndexOf('carriesLiveApproval(', at);
      expect(gate, `no carriesLiveApproval( before "${message}"`).toBeGreaterThan(-1);
      expect(at - gate, `"${message}" is far from the call before it`).toBeLessThan(250);
    }
  });

  it('labels the entry an activated draft replaces from the same predicate', () => {
    expect(positions('carriesApproval: carriesLiveApproval(r.entry)')).toHaveLength(1);
    expect(positions("(carries an admin's approval as a house rule)")).toHaveLength(1);
  });

  it('has no state-keyed warning gate left', () => {
    expect(page.match(/\b(?:holdsApproval|lapsesOnEdit)\b/g) ?? []).toEqual([]);
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
