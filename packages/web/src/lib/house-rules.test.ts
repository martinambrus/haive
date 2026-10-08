import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GlobalKbEnforcementState, GlobalKbEntry } from './api-client';
import {
  carriesLiveApproval,
  describeEnforceSpec,
  enforcementOffers,
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

describe('enforcementOffers', () => {
  const entryIn = (namespace: string, enforcedHash?: string | null) =>
    ({ namespace, enforcedHash }) as GlobalKbEntry;

  it('offers Enforce, Re-enforce and Edit enforcement for an entry of the namespace in use', () => {
    expect(enforcementOffers(entryIn('default', null), 'default').enforce).toBe(true);
    expect(enforcementOffers(entryIn('default', 'hr1:abc'), 'default').enforce).toBe(true);
  });

  it('offers Un-enforce there only with a live approval', () => {
    expect(enforcementOffers(entryIn('default', 'hr1:abc'), 'default').unenforce).toBe(true);
    expect(enforcementOffers(entryIn('default', null), 'default').unenforce).toBe(false);
  });

  it('offers only Un-enforce for an entry of another namespace that holds an approval', () => {
    expect(enforcementOffers(entryIn('elsewhere', 'hr1:abc'), 'default')).toEqual({
      enforce: false,
      unenforce: true,
    });
  });

  it('offers nothing for an entry of another namespace that holds none', () => {
    const nothing = { enforce: false, unenforce: false };
    expect(enforcementOffers(entryIn('elsewhere', null), 'default')).toEqual(nothing);
    expect(enforcementOffers(entryIn('elsewhere'), 'default')).toEqual(nothing);
  });

  it('offers no Enforce until the namespace in use is known', () => {
    expect(enforcementOffers(entryIn('default', 'hr1:abc'), null)).toEqual({
      enforce: false,
      unenforce: true,
    });
  });

  it('compares the namespaces as the api does, exactly', () => {
    expect(enforcementOffers(entryIn('Default', null), 'default').enforce).toBe(false);
    expect(enforcementOffers(entryIn('default ', null), 'default').enforce).toBe(false);
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

  it('offers Un-enforce to an admin for every entry that carriesLiveApproval, whatever its state', () => {
    expect(positions('const unenforceable = canEnforce && offers.unenforce;')).toHaveLength(1);
    expect(positions('if (!note && !action && !unenforceable) return null;')).toHaveLength(1);
    expect(positions('{unenforceable && (')).toHaveLength(1);
    expect(positions("state === 'enforced' && e.status === 'active'")).toEqual([]);
    const edited = { enforcementState: { state: 'edited' } } as GlobalKbEntry;
    expect(carriesLiveApproval({ ...edited, enforcedHash: 'hr1:abc' })).toBe(true);
    expect(carriesLiveApproval({ ...edited, enforcedHash: null })).toBe(false);
  });

  it('offers Enforce, Re-enforce and Edit enforcement only for the namespace the config returned', () => {
    expect(positions('setInstanceNamespace(')).toHaveLength(1);
    expect(positions('setInstanceNamespace(cc.namespace);')).toHaveLength(1);
    expect(positions('enforcementOffers(')).toHaveLength(1);
    expect(positions('enforcementOffers(e, instanceNamespace)')).toHaveLength(1);
    const gate = page.indexOf('if (!offers.enforce) action = null;');
    expect(gate, 'no gate on the action').toBeGreaterThan(-1);
    expect(page.indexOf('action = {', gate), 'an action is set after the gate').toBe(-1);
  });

  it('shows the title and the description as the prompt carries them, and the body as stored', () => {
    expect(positions('const title = collapseToLine(entry.title);')).toHaveLength(1);
    expect(positions('const description = collapseToLine(entry.description);')).toHaveLength(1);
    expect(positions('content={title}')).toHaveLength(1);
    expect(positions('content={description}')).toHaveLength(1);
    expect(positions('content={entry.title}')).toEqual([]);
    expect(positions('content={entry.description}')).toEqual([]);
    expect(positions('content={entry.body}')).toHaveLength(1);
    expect(positions('Title, as agents see it')).toHaveLength(1);
    expect(positions('Description, as agents see it')).toHaveLength(1);
    expect(positions('Body, as agents see it')).toHaveLength(1);
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
