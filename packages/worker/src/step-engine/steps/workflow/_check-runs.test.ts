import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { recordCheckRun } from './_check-runs.js';
import { TaskCancelledError, type StepContext } from '../../step-definition.js';

const m = vi.hoisted(() => ({
  exec: vi.fn(),
  ledger: vi.fn(),
  provision: vi.fn(),
  ddevExec: vi.fn(),
}));
vi.mock('../../../sandbox/ddev-playwright.js', () => ({
  ensureDdevPlaywrightBrowsers: m.provision,
  killStalePlaywrightRuns: async () => {},
}));
vi.mock('../../../sandbox/ddev-runner.js', async (original) => ({
  ...(await original<typeof import('../../../sandbox/ddev-runner.js')>()),
  ddevExec: m.ddevExec,
}));
vi.mock('./_app-runtime.js', () => ({
  ensureAppServing: async () => ({ mode: 'none', url: null }),
  withDdevProgress: async (_ctx: unknown, _label: string, run: (line: () => void) => unknown) =>
    run(() => {}),
}));
vi.mock('../../../sandbox/step-command.js', () => ({ runStepCommandInSandbox: m.exec }));
vi.mock('../../task-ledger.js', () => ({ recordLedgerEntry: m.ledger }));
import { phase5VerifyStep } from './08-phase-5-verify.js';
import { testManagementStep } from './08b-test-management.js';

function fixture() {
  const f = createFakeDb({ taskCheckRuns: schema.taskCheckRuns });
  const ctx = {
    taskId: '00000000-0000-4000-8000-000000000001',
    taskStepId: '00000000-0000-4000-8000-000000000002',
    round: 0,
    rerunGeneration: 0,
    db: f.db as unknown as Database,
    logger: { warn: vi.fn(), info: vi.fn() },
    emitProgress: vi.fn(async () => {}),
    workspacePath: '/wt',
  } as unknown as StepContext;
  return { f, ctx, rows: () => f.rows(schema.taskCheckRuns) };
}
const identity = { stepId: '08-phase-5-verify', slot: 'test' as const, iteration: 0 };
const verdict = (r: { ran: boolean; passed: boolean }) =>
  !r.ran ? ('not_run' as const) : r.passed ? ('passed' as const) : ('failed' as const);
const run = (ctx: StepContext, result = { ran: true, passed: true }, over = {}) =>
  recordCheckRun(ctx, { ...identity, ...over }, async () => result, verdict);
beforeEach(() => {
  m.exec.mockReset().mockResolvedValue({ ran: true, exitCode: 0, output: '' });
});

it.each(['test', 'lint', 'php_lint', 'typecheck'] as const)(
  'starts %s before executing and finalizes timestamps',
  async (slot) => {
    const s = fixture();
    await recordCheckRun(
      s.ctx,
      { ...identity, slot },
      async () => {
        expect(s.rows()[0]).toMatchObject({ slot, outcome: 'running', endedAt: null });
        return { ran: true, passed: true };
      },
      verdict,
    );
    expect(s.rows()[0]).toMatchObject({ slot, outcome: 'passed', endedAt: expect.any(Date) });
  },
);
it.each([
  [{ ran: true, passed: true }, 'passed'],
  [{ ran: true, passed: false }, 'failed'],
  [{ ran: false, passed: false }, 'not_run'],
] as const)('records the classified outcome %s', async (result, outcome) => {
  const s = fixture();
  await run(s.ctx, result);
  expect(s.rows()[0]?.outcome).toBe(outcome);
});
it('preserves the cancellation and finalizes an interrupted run', async () => {
  const s = fixture();
  const error = new TaskCancelledError();
  await expect(
    recordCheckRun(
      s.ctx,
      identity,
      async () => {
        throw error;
      },
      verdict,
    ),
  ).rejects.toBe(error);
  expect(s.rows()[0]).toMatchObject({ outcome: 'interrupted', endedAt: expect.any(Date) });
});
it('re-executes a replay; explicit retry and loop iterations get new attempts', async () => {
  const s = fixture();
  await run(s.ctx);
  const execute = vi.fn(async () => ({ ran: true, passed: false }));
  expect(await recordCheckRun(s.ctx, identity, execute, verdict)).toEqual({
    ran: true,
    passed: false,
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(s.rows()[0]?.outcome).toBe('failed');
  s.ctx.epoch = 9;
  await run(s.ctx);
  expect(s.rows()).toHaveLength(1);
  s.ctx.rerunGeneration = 1;
  await run(s.ctx);
  await run(s.ctx, undefined, { iteration: 1 });
  expect(s.rows()).toHaveLength(3);
});
it.each(['running', 'interrupted', 'passed', 'failed', 'not_run'] as const)(
  'takes over a prior %s observation before executing',
  async (outcome) => {
    const s = fixture();
    await run(s.ctx);
    s.f.patch(schema.taskCheckRuns, s.rows()[0]!.id as string, {
      outcome,
      startedAt: new Date(0),
      endedAt: new Date(1000),
    });
    await recordCheckRun(
      s.ctx,
      identity,
      async () => {
        expect(s.rows()[0]).toMatchObject({ outcome: 'running', endedAt: null });
        expect(s.rows()[0]?.startedAt).not.toEqual(new Date(0));
        return { ran: true, passed: true };
      },
      verdict,
    );
    expect(s.rows()).toHaveLength(1);
    expect(s.rows()[0]).toMatchObject({ outcome: 'passed', endedAt: expect.any(Date) });
  },
);
it.each(['insert', 'update'] as const)(
  'a failed %s warns without failing the check',
  async (op) => {
    const s = fixture();
    if (op === 'insert')
      s.f.hooks.beforeInsert = async () => {
        throw new Error('offline');
      };
    else
      s.f.hooks.beforeUpdate = async () => {
        throw new Error('offline');
      };
    expect(await run(s.ctx)).toEqual({ ran: true, passed: true });
    expect(s.ctx.logger.warn).toHaveBeenCalled();
  },
);

const cmd = { kind: 'host' as const, label: 'npm run check', argv: ['npm', 'run', 'check'] };
const verifyArgs = (over = {}) => ({
  detected: {
    workspacePath: '/wt',
    ddevMode: false,
    test: cmd,
    lint: cmd,
    phpLint: cmd,
    typecheck: cmd,
  },
  formValues: { runTest: true, runLint: true, runTypecheck: true },
  iteration: 0,
  previousIterations: [],
  ...over,
});
it('verify records each selected slot and no skipped slot', async () => {
  const s = fixture();
  await phase5VerifyStep.apply(s.ctx, verifyArgs());
  expect(s.rows().map((r) => [r.slot, r.outcome])).toEqual([
    ['test', 'passed'],
    ['lint', 'passed'],
    ['php_lint', 'passed'],
    ['typecheck', 'passed'],
  ]);
  await phase5VerifyStep.apply(s.ctx, verifyArgs());
  expect(m.exec).toHaveBeenCalledTimes(8);
  expect(s.rows()).toHaveLength(4);
  const skipped = fixture();
  await phase5VerifyStep.apply(skipped.ctx, verifyArgs({ formValues: {} }));
  expect(skipped.rows()).toHaveLength(0);
});
it('verify classifies environment stops before recording not_run', async () => {
  const s = fixture();
  m.exec.mockResolvedValue({
    ran: true,
    exitCode: 1,
    output: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome",
  });
  await phase5VerifyStep.apply(
    s.ctx,
    verifyArgs({
      detected: {
        workspacePath: '/wt',
        ddevMode: false,
        test: cmd,
        lint: null,
        typecheck: null,
        testFramework: 'playwright',
      },
    }),
  );
  expect(s.rows()[0]?.outcome).toBe('not_run');
});
const selectiveArgs = (iteration = 0) => ({
  detected: {
    workspacePath: '/wt',
    primary: 'vitest',
    frameworkRoots: { vitest: '' },
    ddev: false,
  },
  formValues: { action: 'manage', runTests: true },
  iteration,
  previousIterations: [],
  llmOutput: {
    tests_created: ['tests/a.test.ts'],
    tests_updated: [],
    tests_deleted: [],
    notes: '',
  },
});
it('selective runs record each loop pass, preserve retry history and skip no-change runs', async () => {
  const s = fixture();
  await testManagementStep.apply(s.ctx, selectiveArgs() as never);
  await testManagementStep.apply(s.ctx, selectiveArgs() as never);
  await testManagementStep.apply(s.ctx, selectiveArgs(1) as never);
  expect(s.rows().map((r) => [r.stepId, r.slot, r.outcome])).toEqual([
    ['08b-test-management', 'test', 'passed'],
    ['08b-test-management', 'test', 'passed'],
  ]);
  expect(m.exec).toHaveBeenCalledTimes(3);
  await testManagementStep.apply(s.ctx, {
    ...selectiveArgs(),
    formValues: { action: 'skip' },
  } as never);
  expect(s.rows()).toHaveLength(2);
});

const applyCheck = async (step: '08' | '08b', ctx: StepContext) =>
  step === '08'
    ? phase5VerifyStep.apply(ctx, verifyArgs())
    : testManagementStep.apply(ctx, selectiveArgs() as never);

it.each(['08', '08b'] as const)(
  '%s apply re-runs recovery observations and keeps fresh diagnostics',
  async (step) => {
    for (const outcome of ['running', 'interrupted', 'failed'] as const) {
      const s = fixture();
      await applyCheck(step, s.ctx);
      for (const row of s.rows()) s.f.patch(schema.taskCheckRuns, row.id as string, { outcome });
      m.exec
        .mockClear()
        .mockResolvedValue({ ran: true, exitCode: 1, output: 'fresh assertion failure' });
      const result = await applyCheck(step, s.ctx);
      expect(m.exec).toHaveBeenCalledTimes(step === '08' ? 4 : 1);
      expect(s.rows()).toHaveLength(step === '08' ? 4 : 1);
      expect(s.rows().every((r) => r.outcome === 'failed')).toBe(true);
      const check = 'test' in result ? result.test : result.testRun;
      expect(check).toMatchObject({ ran: true, passed: false, output: 'fresh assertion failure' });
    }
  },
);

it.each(['08', '08b'] as const)(
  '%s outcome is unchanged by a recording failure at begin or finish',
  async (step) => {
    for (const op of ['begin', 'finish'] as const) {
      for (const exitCode of [0, 1]) {
        m.exec.mockResolvedValue({ ran: true, exitCode, output: 'command diagnostics' });
        const baseline = await applyCheck(step, fixture().ctx);
        const s = fixture();
        const fail = async () => {
          throw new Error('recording offline');
        };
        if (op === 'begin') s.f.hooks.beforeInsert = fail;
        else s.f.hooks.beforeUpdate = fail;
        expect(await applyCheck(step, s.ctx)).toEqual(baseline);
        expect(s.ctx.logger.warn).toHaveBeenCalled();
      }
    }
  },
);

it('starts selective timing after browser provisioning, then classifies environment stops', async () => {
  const s = fixture();
  m.provision.mockImplementation(async () => {
    expect(s.rows()).toHaveLength(0);
    return { attempted: false, ok: true, note: null };
  });
  m.ddevExec.mockResolvedValue({
    exitCode: 1,
    output: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome",
  });
  const args = selectiveArgs();
  await testManagementStep.apply(s.ctx, {
    ...args,
    detected: {
      ...args.detected,
      primary: 'playwright',
      frameworkRoots: { playwright: '' },
      ddev: true,
      repoSubpath: 'repo',
    },
    llmOutput: { ...args.llmOutput, tests_created: ['tests/a.spec.ts'] },
  } as never);
  expect(s.rows()[0]?.outcome).toBe('not_run');
});

it('records a selective DDEV runner environment stop, but no command creates no row', async () => {
  const args = selectiveArgs();
  const unavailable = fixture();
  const result = await testManagementStep.apply(unavailable.ctx, {
    ...args,
    detected: { ...args.detected, primary: 'phpunit', frameworkRoots: { phpunit: '' }, ddev: true },
    llmOutput: { ...args.llmOutput, tests_created: ['tests/FooTest.php'] },
  } as never);
  expect(result.testRun).toMatchObject({ ran: false, passed: false });
  expect(result.degradedNote).toContain('DDEV runner unavailable');
  expect(unavailable.rows()).toHaveLength(1);
  expect(unavailable.rows()[0]).toMatchObject({ outcome: 'not_run', endedAt: expect.any(Date) });
  expect(m.exec).not.toHaveBeenCalled();

  const noCommand = fixture();
  await testManagementStep.apply(noCommand.ctx, {
    ...args,
    llmOutput: { ...args.llmOutput, tests_created: ['notes.md'] },
  } as never);
  expect(noCommand.rows()).toHaveLength(0);
});
