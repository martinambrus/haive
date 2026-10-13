import { describe, expect, it } from 'vitest';
import { CLI_DISPATCH_STEPS } from '@haive/shared';
import { buildUpcomingCliSteps } from '../src/routes/tasks/_helpers.js';
import { staticStepFlags } from './step-flags-fixture.js';

const flags = staticStepFlags();

/** buildUpcomingCliSteps only reads preferences — every select below returns no rows, so
 *  these tests exercise the FILTERING (which steps the CLIs tab offers) and the role/seat
 *  attachment, not the preference resolution that enrichStepsWithCliPreferences owns and
 *  that the step-card path already covers. */
function makeFakeDb(): never {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return db as never;
}

const ids = async (taskType: string, started: string[] = []): Promise<string[]> =>
  (await buildUpcomingCliSteps(makeFakeDb(), flags, 'user-1', 'task-1', taskType, started)).map(
    (s) => s.stepId,
  );

describe('buildUpcomingCliSteps', () => {
  it("offers only the CLI steps of the task's own pipeline", async () => {
    const workflow = await ids('workflow');
    expect(workflow).toContain('08a-browser-verify');
    expect(workflow).toContain('07b-phase-4-validate');
    // onboarding + kb_author steps belong to other pipelines
    expect(workflow).not.toContain('09_5-skill-generation');
    expect(workflow).not.toContain('01-kb-enrich');
    expect(await ids('onboarding')).toContain('09_5-skill-generation');
    expect(await ids('kb_author')).toEqual(['01-kb-enrich']);
  });

  it('lists a type without a snapshot in run order, by the catalog step index', async () => {
    const swapped = new Map(flags);
    swapped.set('08c-code-review', { ...flags.get('08c-code-review')!, stepIndex: -1 });
    const out = await buildUpcomingCliSteps(
      makeFakeDb(),
      swapped,
      'user-1',
      'task-1',
      'workflow',
      [],
    );
    expect(out[0]?.stepId).toBe('08c-code-review');
    const expected = CLI_DISPATCH_STEPS.filter(
      (s) => s.workflowType === 'workflow' && s.id !== '00-model-health-workflow',
    ).map((s) => s.id);
    expect(await ids('workflow')).toEqual(expected);
  });

  it('excludes steps that already have a row', async () => {
    const started = ['08a-browser-verify', '07b-phase-4-validate'];
    const out = await ids('workflow', started);
    expect(out).not.toContain('08a-browser-verify');
    expect(out).not.toContain('07b-phase-4-validate');
    expect(out).toContain('08c-code-review');
  });

  it('excludes the model-health canary — its CLI is the task default, not a step pref', async () => {
    expect(await ids('workflow')).not.toContain('00-model-health-workflow');
    expect(await ids('onboarding')).not.toContain('00-model-health-onboarding');
  });

  it("carries the catalog title and each step's loop roles / fan-out seats", async () => {
    const out = await buildUpcomingCliSteps(
      makeFakeDb(),
      flags,
      'user-1',
      'task-1',
      'workflow',
      [],
    );
    const browser = out.find((s) => s.stepId === '08a-browser-verify');
    expect(browser?.title).toBe('Phase 5a: Browser validation');
    expect(browser?.cliRoles?.map((r) => r.id)).toEqual(['tester', 'fixer']);
    expect(browser?.miningSeats).toBeUndefined();

    const review = out.find((s) => s.stepId === '08c-code-review');
    expect(review?.miningSeats?.map((r) => r.id)).toContain('security-code-reviewer');
    // Fan-out seats must NOT surface as cliRoles: that field's length is loopPassesPerRound.
    expect(review?.cliRoles).toBeUndefined();
  });

  it('returns nothing for a pipeline with no CLI steps of its own', async () => {
    expect(await ids('env_replicate')).toEqual([]);
    expect(await ids('run_app')).toEqual([]);
    // ...and nothing once every CLI step of the pipeline has started.
    const every = CLI_DISPATCH_STEPS.filter((s) => s.workflowType === 'workflow').map((s) => s.id);
    expect(await ids('workflow', every)).toEqual([]);
  });
});

describe('buildUpcomingCliSteps for a task with a run list snapshot', () => {
  const CUSTOM = ['01-worktree-setup', '07-phase-2-implement', '08c-code-review'];
  const bySnapshot = async (
    taskType: string,
    snapshot: string[] | null,
    started: string[] = [],
  ): Promise<string[]> =>
    (
      await buildUpcomingCliSteps(
        makeFakeDb(),
        flags,
        'user-1',
        'task-1',
        taskType,
        started,
        false,
        snapshot,
      )
    ).map((s) => s.stepId);

  it('offers the CLI steps a custom task will run, and no others', async () => {
    const out = await bySnapshot('review_only', CUSTOM);
    expect(out).toContain('07-phase-2-implement');
    expect(out).toContain('08c-code-review');
    expect(out).not.toContain('01-worktree-setup');
    expect(out).not.toContain('08a-browser-verify');
  });

  it('lists the steps in the order the snapshot runs them', async () => {
    expect(await bySnapshot('review_only', ['08c-code-review', '07-phase-2-implement'])).toEqual([
      '08c-code-review',
      '07-phase-2-implement',
    ]);
  });

  it('drops a snapshot step that already has a row, and the model-health canary', async () => {
    const out = await bySnapshot(
      'review_only',
      ['00-model-health-workflow', ...CUSTOM],
      ['07-phase-2-implement'],
    );
    expect(out).toEqual(['08c-code-review']);
  });

  it('answers a task without a snapshot by its type, as before', async () => {
    expect(await bySnapshot('workflow', null)).toEqual(await ids('workflow'));
    expect(await bySnapshot('kb_author', null)).toEqual(['01-kb-enrich']);
    expect(await bySnapshot('review_only', null)).toEqual([]);
  });

  it('answers a built-in static type with its own steps the same either way', async () => {
    const onboarding = CLI_DISPATCH_STEPS.filter((s) => s.workflowType === 'onboarding').map(
      (s) => s.id,
    );
    expect(await bySnapshot('onboarding', onboarding)).toEqual(await ids('onboarding'));
  });
});
