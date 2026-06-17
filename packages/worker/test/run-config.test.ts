import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { runConfigStep } from '../src/step-engine/steps/workflow/06-run-config.js';

function detectedStub(ddevMode: boolean) {
  return {
    specBody: '# Spec',
    ddevMode,
    appRunnerMode: false,
    taskAdversarialQaLevel: null,
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

  it('lists the inputs directly, with no collapsible accordion wrapper', () => {
    const schema = runConfigStep.form!(makeApplyCtx().ctx, detectedStub(true)) as FormSchema;
    expect(schema.fields.some((f) => f.type === 'accordion')).toBe(false);
    const ids = schema.fields.map((f) => f.id);
    expect(ids).toContain('adversarialQaLevel');
    expect(ids).toContain('browserMode');
    expect(ids).toContain('testRunTests');
  });
});

describe('06-run-config apply', () => {
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
