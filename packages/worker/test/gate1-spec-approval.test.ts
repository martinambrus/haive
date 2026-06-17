import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  buildSpecSummary,
  gate1SpecApprovalStep,
} from '../src/step-engine/steps/workflow/06-gate-1-spec-approval.js';

describe('buildSpecSummary', () => {
  it('returns an empty string for empty / whitespace input', () => {
    expect(buildSpecSummary('')).toBe('');
    expect(buildSpecSummary('   \n\n  ')).toBe('');
  });

  it('keeps the leading heading + first paragraph as-is for short specs', () => {
    const md = '# Title\n\nFirst paragraph line.\nSecond paragraph line.\n';
    expect(buildSpecSummary(md)).toBe('# Title\n\nFirst paragraph line.\nSecond paragraph line.');
  });

  it('stops at the next blank line once 6 non-empty lines are kept', () => {
    const md = [
      '# Title',
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
      '', // 6 lines kept (heading + p1..p5) — break here
      '## Should not appear',
      'cut content',
    ].join('\n');
    const out = buildSpecSummary(md);
    expect(out).not.toContain('Should not appear');
    expect(out).not.toContain('cut content');
    expect(out).toContain('# Title');
    expect(out).toContain('p5');
  });

  it('hard-caps at 12 lines when there are no blank breaks', () => {
    const md = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = buildSpecSummary(md);
    expect(out.split('\n')).toHaveLength(12);
    expect(out).toContain('line 0');
    expect(out).toContain('line 11');
    expect(out).not.toContain('line 12');
  });

  it('skips over fenced code blocks instead of dumping them into the summary', () => {
    const md = ['# Title', '', '```ts', 'const x = 1;', 'const y = 2;', '```', 'After fence.'].join(
      '\n',
    );
    const out = buildSpecSummary(md);
    expect(out).not.toContain('const x');
    expect(out).not.toContain('```');
    expect(out).toContain('# Title');
    expect(out).toContain('After fence.');
  });

  it('falls back to a head slice when the body is only fenced code', () => {
    const md = '```ts\nlong code only\n```';
    const out = buildSpecSummary(md);
    // Head-slice fallback: returns the trimmed original (under 1500 chars).
    expect(out).toBe(md);
  });

  it('respects the 1500-char budget', () => {
    const md = Array.from({ length: 6 }, () => 'x'.repeat(300)).join('\n');
    const out = buildSpecSummary(md);
    // 5 lines × 300 = 1500 chars hits budget; line 6 should be dropped.
    expect(out.length).toBeLessThanOrEqual(1500 + 5); // +newlines
    expect(out.split('\n').length).toBeLessThanOrEqual(5);
  });

  it('never reaches an end-of-spec comprehension quiz', () => {
    const md = [
      '# Spec: realistic',
      '',
      'Goal paragraph one.',
      'Goal paragraph two.',
      'Goal paragraph three.',
      'Goal paragraph four.',
      'Goal paragraph five.',
      'Goal paragraph six.',
      '',
      '## Approach',
      'Do the thing.',
      '',
      '## Comprehension Quiz',
      '### Q1: ok?',
      '- [x] yes',
      '- [ ] no',
    ].join('\n');
    const out = buildSpecSummary(md);
    expect(out).toContain('Goal paragraph one.');
    expect(out).not.toContain('Comprehension Quiz');
    expect(out).not.toContain('[x]');
  });
});

function detectedStub() {
  return {
    specBody: '# Spec',
    specSummary: '# Spec',
    qualityScore: 9,
    qualityVerdict: 'PASS',
    qualityFindings: [],
    iterationHistory: [],
    exhaustedBudget: false,
  };
}

function makeApplyCtx(): {
  ctx: StepContext;
  events: { eventType: string; payload: { feedback?: string } }[];
} {
  const events: { eventType: string; payload: { feedback?: string } }[] = [];
  const db = {
    insert: () => ({
      values: async (row: { eventType: string; payload: { feedback?: string } }) => {
        events.push({ eventType: row.eventType, payload: row.payload });
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
  return { ctx, events };
}

function applyArgs(formValues: Record<string, unknown>) {
  return {
    detected: detectedStub(),
    formValues,
    iteration: 0,
    previousIterations: [],
  } as never;
}

describe('gate-1 spec approval (run config now lives in 06-run-config)', () => {
  it('rejecting records feedback and returns reject without throwing', async () => {
    const { ctx, events } = makeApplyCtx();
    const out = (await gate1SpecApprovalStep.apply(
      ctx,
      applyArgs({ decision: 'reject', feedback: 'redo' }),
    )) as { decision: string; feedback: string };
    expect(out.decision).toBe('reject');
    expect(out.feedback).toBe('redo');
    expect(events[0]?.eventType).toBe('spec.rejected');
    expect(events[0]?.payload?.feedback).toBe('redo');
  });

  it('reviseLoop routes a reject back to the spec generator (04) and finalizes an approve', () => {
    const hook = gate1SpecApprovalStep.reviseLoop!;
    expect(hook.evaluate({ decision: 'reject', feedback: '' })).toEqual({
      targetStepId: '04-phase-0b-pre-planning',
    });
    expect(hook.evaluate({ decision: 'approve', feedback: '' })).toBeNull();
  });

  it('approving records a spec.approved event and returns approve (no task writes here)', async () => {
    const { ctx, events } = makeApplyCtx();
    const out = (await gate1SpecApprovalStep.apply(
      ctx,
      applyArgs({ decision: 'approve', feedback: 'looks good' }),
    )) as { decision: string; feedback: string };
    expect(out.decision).toBe('approve');
    expect(out.feedback).toBe('looks good');
    expect(events.map((e) => e.eventType)).toContain('spec.approved');
  });

  it('form shows the approve/reject decision + feedback, not the run config', () => {
    const schema = gate1SpecApprovalStep.form!(makeApplyCtx().ctx, detectedStub()) as FormSchema;
    const ids = schema.fields.map((f) => f.id);
    expect(ids).toContain('decision');
    expect(ids).toContain('feedback');
    expect(ids).not.toContain('runConfig');
    expect(ids).not.toContain('runConfigNote');
  });
});
