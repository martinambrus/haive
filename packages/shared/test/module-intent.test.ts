import { describe, expect, it } from 'vitest';
import { diffModuleIntent, type ModuleIntentRow } from '../src/modularity/index.js';

const LOADED = new Date('2026-10-01T00:00:00.000Z');
const GONE = new Date('2026-10-05T00:00:00.000Z');
const SWITCHED_OFF = new Date('2026-10-14T08:00:00.000Z');
const TORN_DOWN = new Date('2026-10-14T09:30:00.000Z');

const intent = (id: string, over: Partial<ModuleIntentRow> = {}): ModuleIntentRow => ({
  moduleId: id,
  name: `Name ${id}`,
  source: 'local',
  installedVersion: '1.0.0',
  entitlementId: null,
  lastLoadedAt: LOADED,
  missingAt: null,
  deactivatedAt: null,
  tornDownAt: null,
  ...over,
});
const api = (id: string, version = '1.0.0') => ({ id, version });
const report = (...mods: { id: string; version: string }[]) => ({
  at: '2026-10-13T10:00:00.000Z',
  modules: mods,
});

const stateOf = (result: ReturnType<typeof diffModuleIntent>, id: string) =>
  result.rows.find((r) => r.id === id)?.state;

describe('diffModuleIntent', () => {
  it.each([
    ['loaded', [intent('m')], [api('m')], report(api('m'))],
    ['missing', [intent('m', { missingAt: GONE })], [], report()],
    ['missing', [intent('m', { missingAt: GONE })], [api('m')], report()],
    ['unknown', [intent('m')], [], null],
    ['missing', [intent('m', { missingAt: GONE })], [], null],
    ['api-only', [intent('m')], [api('m')], report()],
    ['unknown', [intent('m')], [api('m')], null],
    ['worker-only', [intent('m')], [], report(api('m'))],
    ['worker-only', [], [], report(api('m'))],
    ['unrecorded', [], [api('m')], report()],
    ['unrecorded', [], [api('m')], report(api('m'))],
    ['unrecorded', [], [api('m')], null],
  ] as const)('is %s', (state, rows, loaded, worker) => {
    const result = diffModuleIntent([...rows], [...loaded], worker);
    expect(result.rows).toHaveLength(1);
    expect(stateOf(result, 'm')).toBe(state);
  });

  it('gives one row per id, sorted, with the row facts and ISO dates', () => {
    const result = diffModuleIntent(
      [
        intent('zeta', { entitlementId: 'ent-1', source: 'git' }),
        intent('alpha', { missingAt: GONE }),
      ],
      [api('zeta')],
      report(api('zeta')),
    );
    expect(result.rows.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    expect(result.rows[1]).toEqual({
      id: 'zeta',
      name: 'Name zeta',
      source: 'git',
      entitlementId: 'ent-1',
      state: 'loaded',
      rowVersion: '1.0.0',
      apiVersion: '1.0.0',
      workerVersion: '1.0.0',
      versionDrift: false,
      lastLoadedAt: LOADED.toISOString(),
      missingAt: null,
      deactivatedAt: null,
      tornDownAt: null,
      skippedSeeds: [],
    });
    expect(result.rows[0]!.missingAt).toBe(GONE.toISOString());
  });

  it('carries deactivatedAt as an ISO date from a Date or a string, and null with no row', () => {
    const result = diffModuleIntent(
      [
        intent('a', { deactivatedAt: SWITCHED_OFF }),
        intent('b', { deactivatedAt: SWITCHED_OFF.toISOString() }),
        intent('c'),
      ],
      [api('d')],
      report(api('e')),
    );
    expect(result.rows.map((r) => [r.id, r.deactivatedAt])).toEqual([
      ['a', SWITCHED_OFF.toISOString()],
      ['b', SWITCHED_OFF.toISOString()],
      ['c', null],
      ['d', null],
      ['e', null],
    ]);
  });

  it('carries tornDownAt as an ISO date from a Date or a string, and null with no row', () => {
    const result = diffModuleIntent(
      [
        intent('a', { deactivatedAt: SWITCHED_OFF, tornDownAt: TORN_DOWN }),
        intent('b', { deactivatedAt: SWITCHED_OFF, tornDownAt: TORN_DOWN.toISOString() }),
        intent('c', { deactivatedAt: SWITCHED_OFF }),
      ],
      [api('d')],
      report(api('e')),
    );
    expect(result.rows.map((r) => [r.id, r.tornDownAt])).toEqual([
      ['a', TORN_DOWN.toISOString()],
      ['b', TORN_DOWN.toISOString()],
      ['c', null],
      ['d', null],
      ['e', null],
    ]);
  });

  it('keeps the load state of a deactivated module', () => {
    const result = diffModuleIntent(
      [intent('m', { deactivatedAt: SWITCHED_OFF })],
      [api('m')],
      report(api('m')),
    );
    expect(result.rows[0]).toMatchObject({ state: 'loaded', deactivatedAt: expect.any(String) });
  });

  it('accepts dates already serialised to strings', () => {
    const result = diffModuleIntent(
      [
        intent('m', {
          lastLoadedAt: '2026-10-01T00:00:00.000Z',
          missingAt: '2026-10-05T00:00:00.000Z',
        }),
      ],
      [],
      null,
    );
    expect(result.rows[0]).toMatchObject({
      lastLoadedAt: '2026-10-01T00:00:00.000Z',
      missingAt: '2026-10-05T00:00:00.000Z',
    });
  });

  it.each([
    ['row differs from api', '1.0.0', '2.0.0', '2.0.0'],
    ['api differs from worker', '2.0.0', '2.0.0', '1.0.0'],
    ['row differs from worker', '1.0.0', '1.0.0', '2.0.0'],
    ['all three differ', '1.0.0', '2.0.0', '3.0.0'],
  ])('flags version drift when %s', (_label, row, apiV, workerV) => {
    const result = diffModuleIntent(
      [intent('m', { installedVersion: row })],
      [api('m', apiV)],
      report(api('m', workerV)),
    );
    expect(result.rows[0]).toMatchObject({
      versionDrift: true,
      rowVersion: row,
      apiVersion: apiV,
      workerVersion: workerV,
    });
  });

  it('does not flag drift when a half is simply absent', () => {
    const result = diffModuleIntent([intent('m')], [api('m')], null);
    expect(result.rows[0]).toMatchObject({ versionDrift: false, workerVersion: null });
  });

  it('carries the worker report time, or null with no report', () => {
    expect(diffModuleIntent([], [], report()).workerAt).toBe('2026-10-13T10:00:00.000Z');
    const none = diffModuleIntent([intent('m')], [api('m')], null);
    expect(none.workerAt).toBeNull();
    expect(none.rows[0]!.workerVersion).toBeNull();
  });

  it.each([
    undefined,
    'junk',
    7,
    {},
    { at: 3, modules: 'x' },
    { modules: [null, { id: 4 }] },
    { at: '2026-10-13T10:00:00.000Z' },
    { at: '2026-10-13T10:00:00.000Z', modules: 'x' },
    { at: '2026-10-13T10:00:00.000Z', modules: [{ id: 'm' }] },
    { at: 'x', modules: [] },
    { at: '2026-10-13T10:00:00.000Z', modules: [{ id: 'm', version: '1.0.0' }, null] },
  ])('treats a malformed worker report %j as no report', (worker) => {
    const result = diffModuleIntent([], [api('m')], worker);
    expect(result.workerAt).toBeNull();
    expect(stateOf(result, 'm')).toBe('unrecorded');
  });
});

describe('diffModuleIntent skipped task type seeds', () => {
  const reportWith = (taskTypes: unknown, id = 'm') => ({
    at: '2026-10-13T10:00:00.000Z',
    modules: [{ id, version: '1.0.0', taskTypes }],
  });
  const skippedOf = (worker: unknown, id = 'm') =>
    diffModuleIntent([intent(id)], [api(id)], worker).rows.find((r) => r.id === id)!.skippedSeeds;

  it('carries a slug another row holds, with the source that holds it', () => {
    const worker = reportWith({
      seeded: ['m__daily'],
      conflicts: [{ slug: 'm__weekly', heldBy: 'admin' }],
    });
    expect(skippedOf(worker)).toEqual([{ slug: 'm__weekly', reason: 'conflict', heldBy: 'admin' }]);
  });

  it('carries a seed that failed the checks with the kind of each problem, once each', () => {
    const worker = reportWith({
      seeded: [],
      conflicts: [],
      invalid: [
        {
          slug: 'm__weekly',
          issues: [
            { kind: 'unmet-need', index: 0, stepId: 'module.m.x', needs: 'repository', reason: '' },
            { kind: 'unknown-step', index: 1, stepId: 'gone' },
            { kind: 'unmet-need', index: 2, stepId: 'module.m.y', needs: 'repository', reason: '' },
          ],
        },
      ],
    });
    expect(skippedOf(worker)).toEqual([
      { slug: 'm__weekly', reason: 'invalid', issues: ['unmet-need', 'unknown-step'] },
    ]);
  });

  it('lists conflicts before invalid seeds, each in report order', () => {
    const worker = reportWith({
      seeded: [],
      conflicts: [
        { slug: 'm__b', heldBy: 'admin' },
        { slug: 'm__a', heldBy: 'builtin' },
      ],
      invalid: [{ slug: 'm__c', issues: [{ kind: 'empty' }] }],
    });
    expect(skippedOf(worker).map((s) => s.slug)).toEqual(['m__b', 'm__a', 'm__c']);
  });

  it('reads each module its own entry and leaves the others with none', () => {
    const worker = {
      at: '2026-10-13T10:00:00.000Z',
      modules: [
        {
          id: 'a',
          version: '1.0.0',
          taskTypes: { conflicts: [{ slug: 'a__x', heldBy: 'admin' }] },
        },
        { id: 'b', version: '1.0.0', taskTypes: { seeded: ['b__x'], conflicts: [] } },
      ],
    };
    const result = diffModuleIntent([intent('a'), intent('b'), intent('c')], [], worker);
    expect(result.rows.map((r) => [r.id, r.skippedSeeds.length])).toEqual([
      ['a', 1],
      ['b', 0],
      ['c', 0],
    ]);
  });

  it('gives none for a module the worker did not report, or a report with no seed outcome', () => {
    expect(skippedOf(report())).toEqual([]);
    expect(skippedOf(null)).toEqual([]);
    expect(skippedOf(report(api('m')))).toEqual([]);
  });

  it.each([
    ['no outcome', undefined],
    ['a string outcome', 'junk'],
    ['lists that are not lists', { conflicts: 3, invalid: 'x' }],
    ['entries that are not objects', { conflicts: [null, 7, 'x'], invalid: [null, 7] }],
    ['entries missing their fields', { conflicts: [{ slug: 'm__a' }, { heldBy: 'admin' }] }],
    ['an invalid entry with no slug', { invalid: [{ issues: [{ kind: 'empty' }] }] }],
  ])('skips what it cannot read in %s without dropping the report', (_label, taskTypes) => {
    const result = diffModuleIntent([intent('m')], [api('m')], reportWith(taskTypes));
    expect(result.workerAt).toBe('2026-10-13T10:00:00.000Z');
    expect(result.rows[0]).toMatchObject({ state: 'loaded', skippedSeeds: [] });
  });

  it('keeps an invalid seed whose problems it cannot name, with no kinds', () => {
    const worker = reportWith({ invalid: [{ slug: 'm__a', issues: 'x' }, { slug: 'm__b' }] });
    expect(skippedOf(worker)).toEqual([
      { slug: 'm__a', reason: 'invalid', issues: [] },
      { slug: 'm__b', reason: 'invalid', issues: [] },
    ]);
  });
});
