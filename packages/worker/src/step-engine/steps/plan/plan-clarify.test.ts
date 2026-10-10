import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { PlanPatchError } from '@haive/shared/plan';
import { UNTRUSTED_OPEN } from '../_untrusted-repo.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { MiningRetryError, MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import type { PlanBuildDetect } from './01-plan-build.js';
import {
  actionFieldId,
  answerFieldId,
  buildClarifyForm,
  nextMove,
  outlineExtraLines,
  outsideOutline,
  parseQuestions,
  parseVerdicts,
  steerFieldId,
  type ClarifyRound,
} from './_plan-clarify.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const STEP = '33333333-3333-4333-8333-333333333333';
const REPO = '44444444-4444-4444-8444-444444444444';
const OTHER_ROOT = '55555555-5555-4555-8555-555555555555';
const plan = vi.hoisted(() => ({
  root: null as { id: string } | null,
  patches: [] as unknown[],
  refuse: null as Error | null,
  makesRoot: true,
  created: [] as string[],
  live: null as { rows: unknown[] } | null,
}));

vi.mock('@haive/shared/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/plan')>()),
  findPlanRoot: vi.fn(async () => plan.root),
  renderPlanMarkdown: vi.fn(async () => '# Plan'),
}));
vi.mock('./_plan-prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_plan-prompt.js')>()),
  applyAgentPatch: vi.fn(async (tx: unknown, patch: { ops: unknown[] }) => {
    if (plan.refuse) throw plan.refuse;
    plan.patches.push(patch);
    if (plan.makesRoot && !plan.root) {
      const { schema } = await import('@haive/database');
      await (tx as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } })
        .insert(schema.planNodes)
        .values({
          id: ROOT,
          repositoryId: '44444444-4444-4444-8444-444444444444',
          parentId: null,
          path: `/${ROOT}/`,
          title: 'Root',
          ordinal: 0,
        });
      plan.root = { id: ROOT };
      plan.created = [ROOT];
    }
    return {
      created: plan.created,
      updated: [],
      dropped: [],
      strippedCodeLinks: [],
      refs: {},
    };
  }),
}));
vi.mock('./01-plan-build.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./01-plan-build.js')>()),
  withLiveInputs: vi.fn(async (_ctx: unknown, d: unknown) => d),
}));
vi.mock('./00-plan-inputs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./00-plan-inputs.js')>()),
  loadLiveAttachments: vi.fn(async () => plan.live),
}));
vi.mock('../../../plan/mirror.js', () => ({ writePlanMirror: vi.fn(async () => []) }));

const { planClarifyStep } = await import('./00b-plan-clarify.js');

const build = {
  mode: 'greenfield',
  repositoryId: REPO,
  existingNodeCount: 0,
  hasRoot: false,
  kbFiles: [],
  brief: 'A booking site.',
  repoName: 'clubs',
  inputIndexPath: null,
  visualOnlyInputs: [],
  hasPdfInputs: false,
} as PlanBuildDetect;

function setup({ ownOutline = true } = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    planClarifyRounds: schema.planClarifyRounds,
    planNodes: schema.planNodes,
  });
  // A root that exists before a test starts is this task's own outline unless the test says not.
  if (plan.root && ownOutline) {
    fake.insert(schema.planClarifyRounds, {
      taskId: TASK,
      round: 0,
      action: 'continue',
      answeredAt: new Date(),
      integratedAt: new Date(),
      rootId: ROOT,
    });
  }
  const ctx = {
    db: fake.db,
    taskId: TASK,
    taskStepId: STEP,
    repoPath: '/nonexistent',
    logger: { info: () => {}, warn: () => {} },
  } as unknown as StepContext;
  const mined = (agentId: string, rawOutput: string, status: 'done' | 'failed' = 'done') => {
    fake.insert(schema.taskStepAgentMinings, {
      taskStepId: STEP,
      agentId,
      status,
      consumedAt: null,
    });
    return {
      agentId,
      agentTitle: agentId,
      status,
      output: null,
      rawOutput,
      errorMessage: status === 'failed' ? 'boom' : null,
    } as AgentMiningResult;
  };
  const apply = (
    results: AgentMiningResult[],
    formValues: Record<string, unknown> = {},
    final = true,
  ) =>
    planClarifyStep.apply(ctx, {
      detected: { build, rootId: plan.root?.id ?? null, rounds: [] },
      formValues,
      agentMiningResults: results,
      newAgentMiningResults: results,
      iteration: 0,
      previousIterations: [],
      isFinalMiningAttempt: final,
    });
  const rounds = () => fake.rows(schema.planClarifyRounds);
  const round1 = () => rounds().find((r) => r.round === 1)!;
  return { fake, ctx, mined, apply, rounds, round1 };
}

const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';
const questions = json({
  questions: [
    {
      id: 'payments',
      topic: 'Payments',
      question: 'Who takes payment?',
      why: 'scope',
      suggestions: ['Stripe'],
    },
    { id: 'users', question: 'Who books?', suggestions: [] },
  ],
  nothingOpen: false,
});

async function thrown(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a throw');
    },
    (err: unknown) => err,
  );
}

beforeEach(() => {
  plan.root = null;
  plan.patches = [];
  plan.refuse = null;
  plan.makesRoot = true;
  plan.created = [];
  plan.live = null;
  delete process.env.HAIVE_TEST_BYPASS_LLM;
});

describe('00b-plan-clarify apply', () => {
  it('drafts the outline, then asks the questioner', async () => {
    const { mined, apply, rounds } = setup();
    const outline = mined(
      'clarify-outline',
      json({
        summary: 'outline',
        ops: [
          { op: 'upsert', nodeRef: 'tmp-root', parentRef: null, title: 'Clubs' },
          {
            op: 'upsert',
            nodeRef: 'tmp-pay',
            parentRef: 'tmp-root',
            title: 'Payments',
            kind: 'decision',
          },
          { op: 'upsert', nodeRef: 'tmp-deep', parentRef: 'tmp-pay', title: 'Too deep' },
        ],
      }),
    );
    const err = (await thrown(apply([outline]))) as MiningWaveError;
    expect(err).toBeInstanceOf(MiningWaveError);
    expect(err.dispatches.map((x) => [x.agentId, x.roleKey])).toEqual([
      ['clarify-ask-r1', 'questioner'],
    ]);
    const ops = (plan.patches[0] as { ops: { nodeRef: string }[] }).ops.map((o) => o.nodeRef);
    expect(ops).toEqual(['tmp-root', 'tmp-pay']);
    expect(rounds()).toEqual([
      expect.objectContaining({ round: 0, action: 'continue', rootId: ROOT }),
    ]);
  });

  it('records the questions and parks on the form, which shows them', async () => {
    plan.root = { id: ROOT };
    const { mined, apply, rounds, round1 } = setup();
    expect(await thrown(apply([mined('clarify-ask-r1', questions)]))).toBeInstanceOf(
      ReopenStepFormError,
    );
    expect(rounds().filter((r) => r.round !== 0)).toHaveLength(1);
    expect(round1()).toMatchObject({ round: 1, nothingOpen: false, answeredAt: null });
    const form = planClarifyStep.form!({} as never, {
      build,
      rootId: ROOT,
      rounds: [
        {
          round: 1,
          questions: round1()!.questions as ClarifyRound['questions'],
          nothingOpen: false,
          answers: null,
          steer: null,
          action: null,
          answered: false,
          outcome: null,
          integrated: false,
          rootId: null,
        },
      ],
    });
    expect(form?.fields.map((f) => f.id)).toEqual(['questions__r1', 'steer__r1', 'action__r1']);
  });

  it('sends answers to the planner, then asks again with its verdicts', async () => {
    plan.root = { id: ROOT };
    const { mined, apply, round1 } = setup();
    await thrown(apply([mined('clarify-ask-r1', questions)]));

    const values = {
      [answerFieldId(1, 'payments')]: 'Stripe',
      [answerFieldId(1, 'users')]: '  ',
      [steerFieldId(1)]: 'Mobile first.',
      [actionFieldId(1)]: 'continue',
    };
    const toPlanner = (await thrown(apply([], values))) as MiningWaveError;
    expect(toPlanner.dispatches.map((x) => [x.agentId, x.roleKey])).toEqual([
      ['clarify-integrate-r1', 'planner'],
    ]);
    expect(toPlanner.dispatches[0]!.prompt).toContain(
      'The owner picked this answer the questioner had suggested:',
    );
    expect(toPlanner.dispatches[0]!.prompt).toContain('The owner also said: Mobile first.');
    expect(round1()).toMatchObject({
      answers: [{ questionId: 'payments', answer: 'Stripe', suggested: true }],
      action: 'continue',
    });

    // A redelivered submit carrying other values must not overwrite the recorded answers.
    await thrown(apply([], { ...values, [answerFieldId(1, 'payments')]: 'PayPal' }));
    expect(round1()!.answers).toEqual([
      { questionId: 'payments', answer: 'Stripe', suggested: true },
    ]);

    const integrated = mined(
      'clarify-integrate-r1',
      json({
        summary: 'payments',
        ops: [],
        verdicts: [{ questionId: 'payments', status: 'open', note: 'Which currencies?' }],
      }),
    );
    const next = (await thrown(apply([integrated]))) as MiningWaveError;
    expect(next.dispatches.map((x) => x.agentId)).toEqual(['clarify-ask-r2']);
    expect(next.dispatches[0]!.prompt).toContain('Which currencies?');
    expect(round1()!.integratedAt).not.toBeNull();
  });

  it('ignores a submit meant for an earlier round', async () => {
    plan.root = { id: ROOT };
    const { mined, apply, round1 } = setup();
    await thrown(apply([mined('clarify-ask-r1', questions)]));
    expect(await thrown(apply([], { action__r0: 'build' }))).toBeInstanceOf(ReopenStepFormError);
    expect(round1()!.answeredAt).toBeNull();
  });

  it('builds at once when the owner adds nothing and chooses to build', async () => {
    plan.root = { id: ROOT };
    const { mined, apply } = setup();
    await thrown(apply([mined('clarify-ask-r1', questions)]));
    expect(await apply([], { [actionFieldId(1)]: 'build' })).toEqual({
      rounds: 1,
      outcome: 'built',
    });
  });

  it('re-rolls an unusable questioner reply, then fails the step', async () => {
    plan.root = { id: ROOT };
    const { mined, apply } = setup();
    const empty = mined('clarify-ask-r1', json({ questions: [] }));
    expect(await thrown(apply([empty], {}, false))).toBeInstanceOf(MiningRetryError);
    const err = await thrown(apply([empty], {}, true));
    expect(err).not.toBeInstanceOf(MiningRetryError);
    expect((err as Error).message).toContain('no questions in the reply');
  });

  it('re-rolls an outline that created no root', async () => {
    plan.makesRoot = false;
    const { mined, apply } = setup();
    const outline = mined(
      'clarify-outline',
      json({ summary: 's', ops: [{ op: 'upsert', nodeRef: 'x' }] }),
    );
    expect(await thrown(apply([outline], {}, false))).toBeInstanceOf(MiningRetryError);
  });

  it('re-rolls a refused planner patch, but asks for a Retry on a version conflict', async () => {
    plan.root = { id: ROOT };
    const { mined, apply } = setup();
    await thrown(apply([mined('clarify-ask-r1', questions)]));
    await thrown(
      apply([], { [answerFieldId(1, 'payments')]: 'Stripe', [actionFieldId(1)]: 'continue' }),
    );
    const reply = mined('clarify-integrate-r1', json({ summary: 's', ops: [] }));

    plan.refuse = new PlanPatchError('invalid', 'bad ref');
    expect(await thrown(apply([reply], {}, false))).toBeInstanceOf(MiningRetryError);

    plan.refuse = new PlanPatchError('conflict', 'stale');
    const err = (await thrown(apply([reply], {}, false))) as Error;
    expect(err).not.toBeInstanceOf(MiningRetryError);
    expect(err.message).toContain('Retry this step');
  });

  it('refuses a plan another build or a person created before this task started', async () => {
    plan.root = { id: ROOT };
    const { apply } = setup({ ownOutline: false });
    const err = (await thrown(apply([]))) as Error;
    expect(err.message).toContain('got a plan before this build started');
    const select = planClarifyStep.agentMining!.selectAgents({
      ctx: {} as StepContext,
      detected: { build, rootId: ROOT, rounds: [] },
      formValues: {},
      llmOutput: undefined,
    });
    expect(((await thrown(select)) as Error).message).toContain('got a plan before');
  });

  it('refuses a root someone replaced while a round was parked', async () => {
    plan.root = { id: OTHER_ROOT };
    const { fake, apply } = setup({ ownOutline: false });
    fake.insert(schema.planClarifyRounds, {
      taskId: TASK,
      round: 0,
      action: 'continue',
      answeredAt: new Date(),
      integratedAt: new Date(),
      rootId: ROOT,
    });
    expect(((await thrown(apply([]))) as Error).message).toContain('got a plan before');
  });

  it('redrafts under a fresh agent id when its root was deleted', async () => {
    const { fake, ctx } = setup();
    fake.insert(schema.planClarifyRounds, {
      taskId: TASK,
      round: 0,
      action: 'continue',
      answeredAt: new Date(),
      integratedAt: new Date(),
      rootId: null,
    });
    const earlier = {
      agentId: 'clarify-outline',
      agentTitle: 'Plan outline',
      status: 'done',
      output: null,
      rawOutput: '',
      errorMessage: null,
    } as AgentMiningResult;
    const err = (await thrown(
      planClarifyStep.apply(ctx, {
        detected: { build, rootId: null, rounds: [] },
        formValues: {},
        agentMiningResults: [earlier],
        newAgentMiningResults: [],
        iteration: 0,
        previousIterations: [],
      }),
    )) as MiningWaveError;
    expect(err.dispatches.map((x) => [x.agentId, x.roleKey])).toEqual([
      ['clarify-outline-2', 'planner'],
    ]);
    expect(err.dispatches[0]!.prompt).not.toContain('What the owner already decided');
  });

  it('does not take ownership of a root its outline patch did not create', async () => {
    plan.makesRoot = false;
    const { fake, mined, apply, rounds } = setup();
    fake.insert(schema.planNodes, {
      id: OTHER_ROOT,
      repositoryId: REPO,
      parentId: null,
      path: `/${OTHER_ROOT}/`,
      title: 'Someone else',
      ordinal: 0,
    });
    plan.root = { id: OTHER_ROOT };
    const outline = mined(
      'clarify-outline',
      json({ summary: 's', ops: [{ op: 'link', fromRef: 'x', toRef: 'y', kind: 'affects' }] }),
    );
    expect(((await thrown(apply([outline]))) as Error).message).toContain('got a plan before');
    expect(rounds()).toEqual([expect.objectContaining({ round: 0, rootId: null })]);
  });

  it('fences a picked suggestion as agent text and leaves a typed answer unfenced', async () => {
    plan.root = { id: ROOT };
    const { mined, apply } = setup();
    await thrown(apply([mined('clarify-ask-r1', questions)]));
    const sent = (await thrown(
      apply([], {
        [answerFieldId(1, 'payments')]: 'Stripe',
        [answerFieldId(1, 'users')]: 'Club members only',
        [actionFieldId(1)]: 'continue',
      }),
    )) as MiningWaveError;
    const prompt = sent.dispatches[0]!.prompt;
    expect(prompt).toContain(
      `The owner picked this answer the questioner had suggested:\n${UNTRUSTED_OPEN}\nStripe`,
    );
    expect(prompt).toContain('The owner answered: Club members only');
  });

  it('carries the answered rounds into a redrafted outline', () => {
    const lines = outlineExtraLines({ mode: 'greenfield' }, [
      {
        round: 1,
        questions: [
          { id: 'pay', topic: '', question: 'Who takes payment?', why: '', suggestions: [] },
        ],
        nothingOpen: false,
        answers: [{ questionId: 'pay', answer: 'Stripe only' }],
        steer: 'Mobile first.',
        action: 'continue',
        answered: true,
        outcome: null,
        integrated: true,
        rootId: null,
      },
    ]).join('\n');
    expect(lines).toContain('What the owner already decided');
    expect(lines).toContain('The owner answered: Stripe only');
    expect(lines).toContain('The owner also said: Mobile first.');
    const pending = outlineExtraLines({ mode: 'greenfield' }, [
      {
        round: 1,
        questions: [],
        nothingOpen: false,
        answers: [],
        steer: 'Not yet folded in.',
        action: 'continue',
        answered: true,
        outcome: null,
        integrated: false,
        rootId: null,
      },
    ]).join('\n');
    expect(pending).not.toContain('Not yet folded in.');
  });

  it('refuses to draft an outline once a files-only brief has lost every file', async () => {
    plan.live = { rows: [] };
    const select = planClarifyStep.agentMining!.selectAgents({
      ctx: {} as StepContext,
      detected: { build: { ...build, brief: '' }, rootId: null, rounds: [] },
      formValues: {},
      llmOutput: undefined,
    });
    expect(((await thrown(select)) as Error).message).toContain('nothing to build from');
  });

  it('does nothing under the LLM bypass', async () => {
    process.env.HAIVE_TEST_BYPASS_LLM = '1';
    const { apply } = setup();
    expect(await apply([])).toEqual({ rounds: 0, outcome: 'skipped' });
  });
});

describe('clarify helpers', () => {
  const round = (over: Partial<ClarifyRound>): ClarifyRound => ({
    round: 1,
    questions: [],
    nothingOpen: false,
    answers: null,
    steer: null,
    action: null,
    answered: false,
    outcome: null,
    integrated: false,
    rootId: null,
    ...over,
  });

  it('moves outline, ask, form, integrate, then ask or done', () => {
    expect(nextMove(false, [])).toEqual({ kind: 'outline' });
    expect(nextMove(true, [])).toEqual({ kind: 'ask', round: 1 });
    expect(nextMove(true, [round({})])).toEqual({ kind: 'form', round: 1 });
    expect(nextMove(true, [round({ answered: true })])).toEqual({ kind: 'integrate', round: 1 });
    expect(
      nextMove(true, [round({ answered: true, integrated: true, action: 'continue' })]),
    ).toEqual({
      kind: 'ask',
      round: 2,
    });
    expect(nextMove(true, [round({ answered: true, integrated: true, action: 'build' })])).toEqual({
      kind: 'done',
    });
  });

  it('accepts an empty question list only when nothing is open', () => {
    expect(parseQuestions(json({ questions: [] }))).toBeNull();
    expect(parseQuestions(json({ questions: [], nothingOpen: true }))).toEqual({
      questions: [],
      nothingOpen: true,
    });
  });

  it('drops bad ids and duplicates and caps suggestions', () => {
    const parsed = parseQuestions(
      json({
        questions: [
          { id: 'Bad Id!', question: 'x?' },
          { id: 'a', question: 'A?', suggestions: ['1', '1', '2', '3', '4', '5', 'x'.repeat(200)] },
          { id: 'a', question: 'again?' },
        ],
      }),
    );
    expect(parsed?.questions.map((q) => [q.id, q.suggestions])).toEqual([
      ['a', ['1', '2', '3', '4']],
    ]);
  });

  it('counts an answer the planner gave no verdict for as settled', () => {
    const verdicts = parseVerdicts(
      json({ ops: [], verdicts: [{ questionId: 'b', status: 'open', note: 'n' }] }),
      [
        { questionId: 'a', answer: 'x' },
        { questionId: 'b', answer: 'y' },
      ],
    );
    expect(verdicts.map((v) => v.status)).toEqual(['settled', 'open']);
  });

  it('keeps every new node directly under the root', () => {
    const { kept, dropped } = outsideOutline(
      [
        { op: 'upsert', nodeRef: 'tmp', parentRef: `node:${ROOT}`, title: 'ok' },
        { op: 'upsert', nodeRef: 'tmp2', parentRef: 'tmp', title: 'deep' },
        { op: 'upsert', nodeRef: ROOT, body: 'edit' },
        { op: 'link', fromRef: 'tmp', toRef: ROOT, kind: 'affects' },
      ],
      ROOT,
    );
    expect(kept).toHaveLength(3);
    expect(dropped).toEqual(['deep: only the root may hold new parts here']);
  });

  it('offers no form once the round is answered, and leans to building when nothing is open', () => {
    expect(buildClarifyForm([round({ answered: true })])).toBeNull();
    const form = buildClarifyForm([round({ nothingOpen: true })]);
    const action = form?.fields.find((f) => f.id === actionFieldId(1));
    expect(action && 'default' in action ? action.default : null).toBe('build');
  });
});
