import { beforeEach, describe, expect, it } from 'vitest';
import { CLI_DISPATCH_STEPS, SKIPPABLE_STEP_IDS } from '@haive/shared';
import { loadStepFlags, resetStepFlagsCache, withTaskCustomSteps } from '../src/lib/step-flags.js';
import { buildUpcomingCliSteps, enrichStepsWithCliUsage } from '../src/routes/tasks/_helpers.js';
import { currentStepLabel } from '../src/routes/tasks/_step-label.js';
import { isStepSkippable } from '../src/routes/tasks/_helpers.js';

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
  stepIndex: 0,
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
    expect((await loadStepFlags(db)).size).toBeGreaterThan(0);
    rows = [row('a')];
    expect([...(await loadStepFlags(db)).keys()]).toEqual(['a']);
    expect(state.selects).toBe(2);
  });

  describe('a catalog the worker has not synced yet', () => {
    const skipId = SKIPPABLE_STEP_IDS[0]!;
    const cliStep = CLI_DISPATCH_STEPS.find((s) => s.workflowType === 'workflow')!;

    function expectStaticFlags(flags: Awaited<ReturnType<typeof loadStepFlags>>) {
      expect(flags.has('01-worktree-setup')).toBe(false);
      expect(flags.get(skipId)?.allowSkip).toBe(true);
      expect(flags.get(cliStep.id)).toMatchObject({
        dispatchesStepCli: true,
        stepIndex: CLI_DISPATCH_STEPS.indexOf(cliStep),
        composable: null,
      });
    }

    it('gives the static flags for an empty catalog, and does not keep them', async () => {
      const { db, state } = fakeDb(() => []);
      expectStaticFlags(await loadStepFlags(db));
      expectStaticFlags(await loadStepFlags(db));
      expect(state.selects).toBe(2);
    });

    it('gives the static flags while any row has no step index, and does not keep them', async () => {
      const { db, state } = fakeDb(() => [row('a'), row('b', { stepIndex: null })]);
      const flags = await loadStepFlags(db);
      expectStaticFlags(flags);
      expect(flags.has('a')).toBe(false);
      await loadStepFlags(db);
      expect(state.selects).toBe(2);
    });
  });

  it('lists the static upcoming steps for an empty catalog', async () => {
    const flags = await loadStepFlags(fakeDb(() => []).db);
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as never;
    const upcoming = await buildUpcomingCliSteps(db, flags, 'u', 't', 'workflow', []);
    expect(upcoming.length).toBeGreaterThan(0);
  });
});

describe('withTaskCustomSteps', () => {
  const entry = (slug: string, title: string) => ({
    slug,
    title,
    template: 'Do it',
    capabilities: [],
    timeoutMs: 300_000,
  });
  const customSteps = {
    'custom.t.first': entry('first', 'First step'),
    'custom.t.second': entry('second', 'Second step'),
  };
  const snapshot = ['a', 'custom.t.second', 'b', 'custom.t.first'];
  const owner = { type: 't', repositoryId: null };

  it('answers custom ids from the task copy, at their snapshot position', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a'), row('b')]).db);
    const flags = withTaskCustomSteps(base, { ...owner, runListSnapshot: snapshot, customSteps });
    expect(flags.get('custom.t.second')).toMatchObject({
      stepId: 'custom.t.second',
      title: 'Second step',
      dispatchesStepCli: true,
      allowSkip: false,
      providerSensitive: false,
      cliRoles: null,
      stepIndex: 1,
      composable: { stepId: 'custom.t.second', requires: [], provides: [] },
    });
    expect(flags.get('custom.t.first')).toMatchObject({ title: 'First step', stepIndex: 3 });
    expect(flags.get('a')).toBe(base.get('a'));
  });

  it('never writes into the map it was given', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a')]).db);
    withTaskCustomSteps(base, { ...owner, runListSnapshot: snapshot, customSteps });
    expect(base.has('custom.t.first')).toBe(false);
    expect((await loadStepFlags(fakeDb(() => [row('a')]).db)).has('custom.t.first')).toBe(false);
  });

  it('returns the map itself for a task with no custom steps', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a')]).db);
    expect(
      withTaskCustomSteps(base, { ...owner, runListSnapshot: snapshot, customSteps: null }),
    ).toBe(base);
    expect(
      withTaskCustomSteps(base, { ...owner, runListSnapshot: snapshot, customSteps: {} }),
    ).toBe(base);
  });

  it('ignores a copy whose id is not in the snapshot', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a')]).db);
    const flags = withTaskCustomSteps(base, { ...owner, runListSnapshot: ['a'], customSteps });
    expect(flags.has('custom.t.first')).toBe(false);
  });

  it('keeps the flags of a copy whose tool no longer parses', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a')]).db);
    const tool = {
      name: 'bad_tool',
      description: 'd'.repeat(1025),
      action: 'http-get',
      url: 'https://api.example.com/v1/status',
    };
    const flags = withTaskCustomSteps(base, {
      ...owner,
      runListSnapshot: snapshot,
      customSteps: { 'custom.t.first': { ...entry('first', 'First step'), tools: [tool] } },
    });
    expect(flags.get('custom.t.first')).toMatchObject({
      title: 'First step',
      workflowType: 'custom',
      dispatchesStepCli: true,
      stepIndex: 3,
    });
  });

  it('still gives no flags to a copy whose template does not parse', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a')]).db);
    const flags = withTaskCustomSteps(base, {
      ...owner,
      runListSnapshot: snapshot,
      customSteps: { 'custom.t.first': { ...entry('first', 'First step'), template: '' } },
    });
    expect(flags.has('custom.t.first')).toBe(false);
  });

  it('shows the custom step in the upcoming list in snapshot order and keeps it unskippable', async () => {
    const base = await loadStepFlags(fakeDb(() => [row('a'), row('b')]).db);
    const task = { ...owner, runListSnapshot: snapshot, customSteps };
    const flags = withTaskCustomSteps(base, task);
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as never;
    const upcoming = await buildUpcomingCliSteps(db, flags, 'u', 't', 'tt-x', [], false, snapshot);
    expect(upcoming.map((s) => s.stepId)).toEqual(['custom.t.second', 'custom.t.first']);
    expect(enrichStepsWithCliUsage(flags, [{ stepId: 'custom.t.first' }])[0]!.usesCli).toBe(true);
    expect(isStepSkippable(flags, 'custom.t.first', task)).toBe(false);
  });
});

describe('withTaskCustomSteps and 01-worktree-setup', () => {
  const worktree = row('01-worktree-setup', {
    composable: true,
    entry: {
      stepId: '01-worktree-setup',
      label: 'Worktree setup',
      group: 'setup',
      dispatchesCli: false,
      requires: [{ needs: 'repository', reason: 'Cuts the worktree from the repository.' }],
      provides: ['worktree', 'clean-tree'],
    },
  });
  const pinned = (capabilities: string[]) => ({
    'custom.t.step': {
      slug: 'step',
      title: 'Step',
      template: 'Do it',
      capabilities,
      timeoutMs: 300_000,
    },
  });
  const snapshot = ['01-worktree-setup', 'custom.t.step'];
  const skippable = async (capabilities: string[]) => {
    const base = await loadStepFlags(fakeDb(() => [worktree]).db);
    const task = {
      type: 't',
      repositoryId: 'r1',
      runListSnapshot: snapshot,
      customSteps: pinned(capabilities),
    };
    return isStepSkippable(withTaskCustomSteps(base, task), '01-worktree-setup', task);
  };

  it('keeps the worktree step unskippable under a pinned step that writes files', async () => {
    expect(await skippable(['file_write'])).toBe(false);
  });

  it('lets the worktree step go under a pinned step that only reads', async () => {
    expect(await skippable(['tool_use'])).toBe(true);
  });
});
