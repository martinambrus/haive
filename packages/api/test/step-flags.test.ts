import { beforeEach, describe, expect, it } from 'vitest';
import { loadStepFlags, resetStepFlagsCache } from '../src/lib/step-flags.js';
import { buildUpcomingCliSteps, enrichStepsWithCliUsage } from '../src/routes/tasks/_helpers.js';
import { currentStepLabel } from '../src/routes/tasks/_step-label.js';

const row = (stepId: string, over: Record<string, unknown> = {}) => ({
  stepId,
  source: 'core',
  title: `Title ${stepId}`,
  workflowType: 'workflow',
  dispatchesCli: false,
  dispatchesStepCli: false,
  allowSkip: false,
  providerSensitive: false,
  cliRoles: null,
  stepIndex: null,
  composable: false,
  entry: null,
  ...over,
});

function fakeDb(rows: () => unknown[]) {
  const state = { selects: 0 };
  const db = {
    select: () => ({
      from: async () => {
        state.selects += 1;
        return rows();
      },
    }),
  };
  return { db: db as never, state };
}

beforeEach(() => resetStepFlagsCache());

describe('loadStepFlags', () => {
  it('keys the catalog rows by step id', async () => {
    const { db } = fakeDb(() => [
      row('a', { allowSkip: true, stepIndex: 3 }),
      row('b', { cliRoles: [{ id: 'x', label: 'X' }], dispatchesStepCli: true }),
    ]);
    const flags = await loadStepFlags(db);
    expect([...flags.keys()].sort()).toEqual(['a', 'b']);
    expect(flags.get('a')).toMatchObject({ allowSkip: true, stepIndex: 3, cliRoles: null });
    expect(flags.get('b')).toMatchObject({
      dispatchesStepCli: true,
      cliRoles: [{ id: 'x', label: 'X' }],
    });
  });

  it('answers an id the catalog does not hold with nothing, so every default is the safe one', async () => {
    const flags = await loadStepFlags(fakeDb(() => [row('a')]).db);
    expect(flags.get('zz-unknown')).toBeUndefined();
    expect(enrichStepsWithCliUsage(flags, [{ stepId: 'zz-unknown' }])[0]!.usesCli).toBe(false);
    expect(
      currentStepLabel(
        [{ stepId: 'zz-unknown', round: 0, title: 'T', iterationCount: 4 }],
        'zz-unknown',
        0,
        flags,
      ),
    ).toBe('T (iter ×4)');
  });

  it('reads the table once within the window', async () => {
    const { db, state } = fakeDb(() => [row('a')]);
    await loadStepFlags(db);
    await loadStepFlags(db);
    expect(state.selects).toBe(1);
  });

  it('reads the table again once the window has passed', async () => {
    const { db, state } = fakeDb(() => [row('a')]);
    await loadStepFlags(db, 1_000);
    await loadStepFlags(db, 1_000 + 29_000);
    expect(state.selects).toBe(1);
    await loadStepFlags(db, 1_000 + 31_000);
    expect(state.selects).toBe(2);
  });

  it('never keeps an empty result', async () => {
    let rows: unknown[] = [];
    const { db, state } = fakeDb(() => rows);
    expect((await loadStepFlags(db)).size).toBe(0);
    rows = [row('a')];
    expect((await loadStepFlags(db)).size).toBe(1);
    expect(state.selects).toBe(2);
  });

  it('lists no upcoming step for an empty catalog', async () => {
    const flags = await loadStepFlags(fakeDb(() => []).db);
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as never;
    expect(await buildUpcomingCliSteps(db, flags, 'u', 't', 'workflow', [])).toEqual([]);
  });
});
