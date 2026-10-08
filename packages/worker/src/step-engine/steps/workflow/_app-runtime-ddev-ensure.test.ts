import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const { ensureDdevStarted, ddevPrimaryUrl, passThrough } = vi.hoisted(() => ({
  ensureDdevStarted: vi.fn(),
  ddevPrimaryUrl: vi.fn(),
  // The real guard until a test hands it a finding.
  passThrough: (name: string) => async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return { ...actual, [name]: vi.fn(actual[name] as () => unknown) };
  },
}));

vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  ensureDdevStarted,
  ddevPrimaryUrl,
}));
vi.mock('../../../sandbox/ddev-config-yaml-guard.js', passThrough('checkDdevConfigYaml'));
vi.mock('../../../sandbox/ddev-healthcheck-guard.js', passThrough('checkDdevHealthcheckConfig'));
vi.mock('../../../sandbox/ddev-build-guard.js', passThrough('checkDdevBuildInputs'));
vi.mock('../../../sandbox/ddev-nginx-include-guard.js', passThrough('checkDdevNginxIncludes'));
vi.mock('../../../sandbox/ddev-entrypoint-guard.js', passThrough('checkDdevWebEntrypoints'));

import { RuntimeSlotAbortedError } from '../../../sandbox/runtime-admission.js';
import { DdevBootAbortedError } from '../../../sandbox/ddev-boot-cancellation.js';
import { checkDdevConfigYaml } from '../../../sandbox/ddev-config-yaml-guard.js';
import { checkDdevHealthcheckConfig } from '../../../sandbox/ddev-healthcheck-guard.js';
import { checkDdevBuildInputs } from '../../../sandbox/ddev-build-guard.js';
import { checkDdevNginxIncludes } from '../../../sandbox/ddev-nginx-include-guard.js';
import { checkDdevWebEntrypoints } from '../../../sandbox/ddev-entrypoint-guard.js';
import { AdvisedStepError, TaskCancelledError } from '../../step-definition.js';
import { ensureAppServing, ensureDdevWithProgress } from './_app-runtime.js';

const SUBPATH = 'haive-test-user/haive-test-repo';
const HANDLE = { container: 'haive-ddev-ensured', projectDir: `/repos/${SUBPATH}` };
const stop = new AbortController();
const ctx = {
  taskId: 'task-1',
  signal: stop.signal,
  db: { query: { tasks: { findFirst: vi.fn(async () => null) } } },
} as never;

// 01c, 06a, 07c and 09 call this directly. The step runner tells a Stop from a failure only by
// `instanceof TaskCancelledError`, so a Stop during the runtime slot wait has to leave as that class,
// as ensureAppServing already makes it.
describe('ensureDdevWithProgress', () => {
  beforeEach(() => {
    ensureDdevStarted.mockReset();
  });

  it('maps a Stop during the runtime slot wait to a cancel', async () => {
    ensureDdevStarted.mockRejectedValueOnce(new RuntimeSlotAbortedError('task-1'));

    const err = await ensureDdevWithProgress(ctx, SUBPATH).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, 'the slot wait abort escaped as itself').toBeInstanceOf(TaskCancelledError);
  });

  it('passes any other error through unchanged', async () => {
    const boom = new Error('ddev start failed: boom');
    ensureDdevStarted.mockRejectedValueOnce(boom);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(boom);
  });

  it('maps an interrupted cold boot to a cancel rather than a step failure', async () => {
    ensureDdevStarted.mockRejectedValueOnce(new DdevBootAbortedError());
    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBeInstanceOf(TaskCancelledError);
  });

  it('passes a cancel the ensure itself raised through unchanged', async () => {
    const cancel = new TaskCancelledError();
    ensureDdevStarted.mockRejectedValueOnce(cancel);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(cancel);
  });

  it('does not take an error that only describes an aborted wait for the abort', async () => {
    const lookalike = new Error('runtime slot wait aborted: task task-1 was stopped');
    ensureDdevStarted.mockRejectedValueOnce(lookalike);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).rejects.toBe(lookalike);
  });

  // A Stop after admission, or during a warm start, is not seen by the ensure itself, so the boot
  // returns as if nothing happened, and the caller's migration or import must not run on it.
  it('rechecks for a Stop that landed during the boot before it returns the handle', async () => {
    const cancel = new TaskCancelledError();
    const stopped = {
      taskId: 'task-1',
      signal: stop.signal,
      db: { query: { tasks: { findFirst: vi.fn(async () => null) } } },
      throwIfCancelled: () => {
        throw cancel;
      },
    } as never;
    ensureDdevStarted.mockImplementationOnce(async (_task, _subpath, opts) => {
      await opts.onReady(HANDLE);
      return HANDLE;
    });

    await expect(ensureDdevWithProgress(stopped, SUBPATH)).rejects.toBe(cancel);
  });

  it('rechecks for a Stop that landed during the debug and database wiring', async () => {
    const cancel = new TaskCancelledError();
    let stopPressed = false;
    // Both wirings read the task row first, so the Stop lands while they run.
    const findFirst = vi.fn(async () => {
      stopPressed = true;
      return null;
    });
    const stoppedMidWiring = {
      taskId: 'task-1',
      signal: stop.signal,
      db: { query: { tasks: { findFirst } } },
      throwIfCancelled: () => {
        if (stopPressed) throw cancel;
      },
    } as never;
    ensureDdevStarted.mockImplementationOnce(async (_task, _subpath, opts) => {
      await opts.onReady(HANDLE);
      return HANDLE;
    });

    await expect(ensureDdevWithProgress(stoppedMidWiring, SUBPATH)).rejects.toBe(cancel);
    expect(
      findFirst,
      'the wiring never ran, so the Stop never landed during it',
    ).toHaveBeenCalled();
  });

  it('hands the step abort signal to the ensure and returns the live handle', async () => {
    ensureDdevStarted.mockResolvedValueOnce(HANDLE);

    await expect(ensureDdevWithProgress(ctx, SUBPATH)).resolves.toBe(HANDLE);

    expect(ensureDdevStarted).toHaveBeenCalledWith(
      'task-1',
      SUBPATH,
      expect.objectContaining({ signal: stop.signal }),
    );
  });

  // The message is what the page shows and what `fixLoopOnError` classifies; the advice
  // Haive wrote into it travels apart, so the step runner can hand it over as guidance.
  it.each([
    ['config YAML', checkDdevConfigYaml],
    ['healthcheck', checkDdevHealthcheckConfig],
    ['image-build inputs', checkDdevBuildInputs],
    ['nginx include', checkDdevNginxIncludes],
    ['web entrypoint', checkDdevWebEntrypoints],
  ])(
    'leaves a finding of the %s guard with its advice apart, before any boot',
    async (_n, guard) => {
      vi.mocked(guard).mockResolvedValueOnce({
        problem: 'DDEV config is not valid YAML: x.',
        advice: 'Quote it.',
      });

      const err = await ensureDdevWithProgress(ctx, SUBPATH).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(AdvisedStepError);
      const failure = err as AdvisedStepError;
      expect(failure.message).toBe(
        'DDEV cannot start: DDEV config is not valid YAML: x. Quote it.',
      );
      expect(failure.diagnosis).toBe('DDEV cannot start: DDEV config is not valid YAML: x.');
      expect(failure.advice).toBe('Quote it.');
      expect(ensureDdevStarted, 'a guard failure went on to boot DDEV').not.toHaveBeenCalled();
    },
  );
});

describe('ensureAppServing', () => {
  const USER = '00000000-0000-4000-8000-0000000000a1';
  const REPO = '00000000-0000-4000-8000-0000000000b1';
  const TASK = '00000000-0000-4000-8000-000000000001';

  let root = '';
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The DDEV branch looks up the project URL (up to 30 s) after its last bring-up check, so a Stop
  // landing then must still keep the runtime from reaching the step.
  it('rechecks for a Stop that landed while the DDEV URL resolved', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'haive-serving-stop-'));
    await mkdir(path.join(root, '.ddev'), { recursive: true });
    await writeFile(path.join(root, '.ddev/config.yaml'), 'name: serving-stop\n');
    const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
    fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });

    const cancel = new TaskCancelledError();
    let stopPressed = false;
    ensureDdevStarted.mockReset().mockResolvedValueOnce(HANDLE);
    ddevPrimaryUrl.mockReset().mockImplementationOnce(async () => {
      stopPressed = true;
      return 'https://serving-stop.ddev.site';
    });

    const serving = ensureAppServing({
      db: fake.db as unknown as Database,
      taskId: TASK,
      repoPath: root,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      throwIfCancelled: () => {
        if (stopPressed) throw cancel;
      },
    });

    await expect(serving).rejects.toBe(cancel);
    expect(
      ddevPrimaryUrl,
      'the URL lookup never ran, so the Stop never landed during it',
    ).toHaveBeenCalled();
  });
});
