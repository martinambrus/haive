import { describe, expect, it } from 'vitest';
import { CLI_DISPATCH_STEPS } from '@haive/shared';
import { buildUpcomingCliSteps } from '../src/routes/tasks/_helpers.js';

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
  (await buildUpcomingCliSteps(makeFakeDb(), 'user-1', 'task-1', taskType, started)).map(
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
    const out = await buildUpcomingCliSteps(makeFakeDb(), 'user-1', 'task-1', 'workflow', []);
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
