import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import { ALL_REVIEW_DIMENSION_IDS } from '@haive/shared/review';
import { validateFormValues } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { runConfigStep } from '../src/step-engine/steps/workflow/06-run-config.js';

function detectedStub(ddevMode: boolean) {
  return {
    specBody: '# Spec',
    ddevMode,
    appRunnerMode: false,
    taskAdversarialQaLevel: null,
    taskMaxFixRounds: 5,
    // Path-gates added with execution-path triage: the browser / adversarial-QA
    // fields only render when those steps run under the task's path. A normal
    // full-workflow run keeps both, which is the scenario these form tests assert.
    runsBrowserVerify: true,
    runsAdversarialQa: true,
  };
}

function leafFields(schema: FormSchema): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const field of schema.fields) {
    if (field.type === 'accordion') {
      for (const item of field.items) {
        for (const leaf of item.fields) map.set(leaf.id, leaf as Record<string, unknown>);
      }
    } else {
      map.set(field.id, field as Record<string, unknown>);
    }
  }
  return map;
}

function makeApplyCtx(): { ctx: StepContext; sets: Record<string, unknown>[] } {
  const sets: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  const noop = (): void => undefined;
  const ctx = {
    taskId: 'task-1',
    taskStepId: 'ts-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    signal: new AbortController().signal,
    emitProgress: async () => undefined,
    throwIfCancelled: noop,
  } as unknown as StepContext;
  return { ctx, sets };
}

function applyArgs(formValues: Record<string, unknown>) {
  return {
    detected: detectedStub(false),
    formValues,
    iteration: 0,
    previousIterations: [],
  } as never;
}

describe('06-run-config form', () => {
  it('offers mcp/interactive browser modes only in ddev mode', () => {
    const withDdev = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    const without = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(false)) as FormSchema;
    const modeWith = leafFields(withDdev).get('browserMode') as { options: { value: string }[] };
    const modeWithout = leafFields(without).get('browserMode') as { options: { value: string }[] };
    expect(modeWith.options.map((o) => o.value)).toContain('mcp');
    expect(modeWith.options.map((o) => o.value)).toContain('interactive');
    expect(modeWithout.options.map((o) => o.value)).not.toContain('mcp');
    expect(modeWithout.options.map((o) => o.value)).not.toContain('interactive');
  });

  it('never auto-submits — the user always decides the run config', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    expect(schema.autoSubmit).toBeUndefined();
    expect(runConfigStep.metadata.autoSubmitDefaults).toBeUndefined();
  });

  // Gate-1 used to bury this whole form behind one "Run configuration" accordion,
  // which is why 06 exists as its own step (fddd12a5). The run controls therefore
  // stay TOP-LEVEL. The review-dimension list is the one deliberate exception: it is
  // 14 checkboxes almost nobody changes, and listing them inline would bury the
  // controls above them — the same defect, in reverse.
  it('lists the run controls directly, with only the dimension list collapsed', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    const topLevel = schema.fields.map((f) => f.id);
    expect(topLevel).toContain('adversarialQaLevel');
    expect(topLevel).toContain('browserMode');
    expect(topLevel).toContain('testRunTests');
    const accordions = schema.fields.filter((f) => f.type === 'accordion');
    expect(accordions.map((f) => f.id)).toEqual(['reviewDimensionsSection']);
  });

  it('ticks every review dimension by default', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    const field = leafFields(schema).get('reviewDimensions') as {
      options: { value: string }[];
      defaults: string[];
      required?: boolean;
    };
    expect(field.options.map((o) => o.value)).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
    expect(field.defaults).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
  });

  // Not `required`, and that is load-bearing rather than an omission. In
  // validateFormValues the flag rejects an ABSENT value, which is the legitimate
  // "leave the policy alone" case every programmatic submitter uses, while an
  // explicitly empty array counts as present and skips the check — so the flag
  // failed the good input and guarded nothing. apply() owns the empty case instead.
  it('does not mark the dimension list required', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    const field = leafFields(schema).get('reviewDimensions') as { required?: boolean };
    expect(field.required).toBeUndefined();
  });

  it('pre-ticks only the repository/task selection when it is narrowed', () => {
    const detected = { ...detectedStub(true), reviewDimensionIds: ['security', 'testability'] };
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detected as never) as FormSchema;
    const field = leafFields(schema).get('reviewDimensions') as { defaults: string[] };
    expect(field.defaults).toEqual(['security', 'testability']);
  });

  // detect_output is persisted, so a task whose detect predates this field replays
  // without it. That must read as "every dimension", never as none.
  it('falls back to every dimension when the detect payload predates the field', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    const field = leafFields(schema).get('reviewDimensions') as { defaults: string[] };
    expect(field.defaults).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
  });
});

// The gap that let a green unit suite ship a red CI: every test above calls form()
// and apply() directly, while the runner puts validateFormValues between them. A
// `required: true` on the dimension list passed all of those and still failed every
// submitter that omits the field — which is what the workflow smoke does.
describe('06-run-config server-side validation', () => {
  const validate = (values: Record<string, unknown>) =>
    validateFormValues(
      runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema,
      values,
    );

  // The exact canned payload from packages/worker/test/workflow-smoke.ts, which
  // predates the dimension list and names no dimensions at all.
  const SMOKE_PAYLOAD = {
    adversarialQaLevel: 'none',
    simplifyCode: true,
    sprintDecision: 'use_single_agent',
    sprintAutoResolveConflicts: false,
    sprintReviewEnabled: false,
    verifyRunTest: false,
    verifyRunLint: false,
    verifyRunTypecheck: false,
    browserMode: 'skip',
    browserCheckConsoleErrors: false,
    browserCheckNetworkErrors: false,
    testAction: 'skip',
    testRunTests: false,
    exposeDbPort: false,
    maxFixRounds: '5',
  };

  it('accepts a submission that names no dimensions', () => {
    const res = validate(SMOKE_PAYLOAD);
    expect(res.success ? null : res.issues).toBeNull();
  });

  it('defaults an omitted dimension list to the resolved policy', () => {
    const res = validate(SMOKE_PAYLOAD);
    expect(res.success && res.data.reviewDimensions).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
  });

  it('keeps a narrowed selection the submitter did send', () => {
    const res = validate({ ...SMOKE_PAYLOAD, reviewDimensions: ['security', 'testability'] });
    expect(res.success && res.data.reviewDimensions).toEqual(['security', 'testability']);
  });

  it('rejects an id the catalog does not know', () => {
    const res = validate({ ...SMOKE_PAYLOAD, reviewDimensions: ['not-a-dimension'] });
    expect(res.success).toBe(false);
  });
});

describe('06-run-config apply', () => {
  it('writes the chosen review dimensions to the task row', async () => {
    const { ctx, sets } = makeApplyCtx();
    const out = await runConfigStep.apply(
      ctx,
      applyArgs({ reviewDimensions: ['accessibility', 'security', 'not-a-dimension'] }),
    );
    // Unknown ids dropped, canonical order restored.
    expect(out.reviewDimensions).toEqual(['security', 'accessibility']);
    expect(sets[0]!.reviewDimensions).toEqual(['security', 'accessibility']);
  });

  it('keeps the detected selection when the form came back without the field', async () => {
    const { ctx, sets } = makeApplyCtx();
    const args = {
      ...(applyArgs({ testAction: 'manage' }) as unknown as Record<string, unknown>),
      detected: { ...detectedStub(false), reviewDimensionIds: ['security'] },
    } as never;
    const out = await runConfigStep.apply(ctx, args);
    // Never silently re-widens to all: an old pre-answer must not undo a narrowing.
    expect(out.reviewDimensions).toEqual(['security']);
    expect(sets[0]!.reviewDimensions).toEqual(['security']);
  });

  it('falls back to every dimension when neither the form nor the detect carried one', async () => {
    const { ctx } = makeApplyCtx();
    const out = await runConfigStep.apply(ctx, applyArgs({ testAction: 'manage' }));
    expect(out.reviewDimensions).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
  });

  // "Score nothing" is not a policy anyone expresses by unticking the last box, and
  // storing it would make every reviewer skip every dimension while still reporting
  // a clean run.
  it('treats an explicitly empty selection as the policy, not as "review nothing"', async () => {
    const { ctx, sets } = makeApplyCtx();
    const args = {
      ...(applyArgs({ reviewDimensions: [] }) as unknown as Record<string, unknown>),
      detected: { ...detectedStub(false), reviewDimensionIds: ['security'] },
    } as never;
    const out = await runConfigStep.apply(ctx, args);
    expect(out.reviewDimensions).toEqual(['security']);
    expect(sets[0]!.reviewDimensions).toEqual(['security']);
  });

  it('treats a selection of only unknown ids as the policy too', async () => {
    const { ctx } = makeApplyCtx();
    const out = await runConfigStep.apply(ctx, applyArgs({ reviewDimensions: ['nope', 'gone'] }));
    expect(out.reviewDimensions).toEqual([...ALL_REVIEW_DIMENSION_IDS]);
  });

  it('maps answers to downstream step field ids and writes the task run-config', async () => {
    const { ctx, sets } = makeApplyCtx();
    const output = await runConfigStep.apply(
      ctx,
      applyArgs({
        adversarialQaLevel: 'poc',
        simplifyCode: false,
        sprintDecision: 'use_single_agent',
        sprintAutoResolveConflicts: true,
        sprintReviewEnabled: false,
        verifyRunTest: false,
        verifyRunLint: true,
        verifyRunTypecheck: true,
        browserMode: 'mcp',
        browserCheckConsoleErrors: false,
        browserCheckNetworkErrors: true,
        testAction: 'manage',
        testRunTests: false,
      }),
    );
    expect(sets).toHaveLength(1);
    const patch = sets[0]!;
    expect(patch.simplifyCode).toBe(false);
    expect(patch.adversarialQaLevel).toBe('poc');
    const pre = patch.preAnswers as Record<string, Record<string, unknown>>;
    expect(pre['06a-db-migrate']).toEqual({});
    expect(pre['07-phase-2-implement']).toEqual({});
    expect(pre['06b-sprint-planning']).toEqual({
      decision: 'use_single_agent',
      autoResolveConflicts: true,
      reviewEnabled: false,
    });
    expect(pre['08-phase-5-verify']).toEqual({ runTest: false, runLint: true, runTypecheck: true });
    expect(pre['08a-browser-verify']).toEqual({
      mode: 'mcp',
      checkConsoleErrors: false,
      checkNetworkErrors: true,
    });
    expect(pre['08b-test-management']).toEqual({ action: 'manage', runTests: false });
    expect(pre['08e-insights-triage']).toEqual({ selectedInsights: [] });
    expect((output as { browserMode: string }).browserMode).toBe('mcp');
  });

  it("writes adversarialQaLevel null when 'none' is selected", async () => {
    const { ctx, sets } = makeApplyCtx();
    await runConfigStep.apply(ctx, applyArgs({ adversarialQaLevel: 'none' }));
    expect(sets[0]!.adversarialQaLevel).toBeNull();
  });
});
