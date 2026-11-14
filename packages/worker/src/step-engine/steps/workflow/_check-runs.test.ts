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
const replay = (outcome: string) => ({ ran: outcome !== 'not_run', passed: outcome === 'passed' });
const run = (ctx: StepContext, result = { ran: true, passed: true }, over = {}) =>
  recordCheckRun(ctx, { ...identity, ...over }, async () => result, verdict, replay);
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
      replay,
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
      replay,
    ),
  ).rejects.toBe(error);
  expect(s.rows()[0]).toMatchObject({ outcome: 'interrupted', endedAt: expect.any(Date) });
});
it('does not execute a completed replay; explicit retry and loop iterations get new attempts', async () => {
  const s = fixture();
  await run(s.ctx);
  const execute = vi.fn(async () => ({ ran: true, passed: false }));
  expect(await recordCheckRun(s.ctx, identity, execute, verdict, replay)).toEqual({
    ran: true,
    passed: true,
  });
  expect(execute).not.toHaveBeenCalled();
  s.ctx.epoch = 9;
  await run(s.ctx);
  expect(s.rows()).toHaveLength(1);
  s.ctx.rerunGeneration = 1;
  await run(s.ctx);
  await run(s.ctx, undefined, { iteration: 1 });
  expect(s.rows()).toHaveLength(3);
});
it.each(['running', 'interrupted'] as const)(
  'keeps %s incomplete on replay until a deliberate retry',
  async (outcome) => {
    const s = fixture();
    await run(s.ctx);
    s.f.patch(schema.taskCheckRuns, s.rows()[0]!.id as string, { outcome, endedAt: null });
    await expect(run(s.ctx)).rejects.toThrow(/incomplete/);
    expect(s.rows()).toHaveLength(1);
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
  expect(m.exec).toHaveBeenCalledTimes(4);
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
  expect(m.exec).toHaveBeenCalledTimes(2);
  await testManagementStep.apply(s.ctx, {
    ...selectiveArgs(),
    formValues: { action: 'skip' },
  } as never);
  expect(s.rows()).toHaveLength(2);
});

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
