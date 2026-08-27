import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  buildSpecSummary,
  extractMermaidBlocks,
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

describe('extractMermaidBlocks', () => {
  it('returns the mermaid fences in document order and ignores other languages', () => {
    const md = [
      '# Spec',
      '```ts',
      'const x = 1;',
      '```',
      '```mermaid',
      'graph LR',
      '  A --> B',
      '```',
      'prose',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n');
    expect(extractMermaidBlocks(md)).toEqual([
      '```mermaid\ngraph LR\n  A --> B\n```',
      '```mermaid\nsequenceDiagram\n  A->>B: hi\n```',
    ]);
  });

  it('ignores a mermaid fence nested inside a longer fence', () => {
    const md = ['````markdown', '```mermaid', 'graph LR', '  A --> B', '```', '````'].join('\n');
    expect(extractMermaidBlocks(md)).toEqual([]);
  });

  it('drops an unterminated or empty mermaid fence', () => {
    expect(extractMermaidBlocks('```mermaid\ngraph LR')).toEqual([]);
    expect(extractMermaidBlocks('```mermaid\n\n```')).toEqual([]);
  });
});

describe('gate-1 summary carries the spec diagrams', () => {
  const specBody = [
    '# Spec: thing',
    '',
    'Goal prose.',
    '',
    '```mermaid',
    'graph LR',
    '  A[Task] --> B[Draft spec]',
    '```',
    '',
    '## Comprehension Quiz',
  ].join('\n');

  function summaryBody(overrides: Record<string, unknown> = {}): string {
    const detected = {
      ...detectedStub(),
      specBody,
      specSummary: buildSpecSummary(specBody),
      ...overrides,
    };
    const schema = gate1SpecApprovalStep.form!(makeApplyCtx().ctx, detected) as FormSchema;
    return schema.infoSections!.find((s) => s.title === 'Specification summary')!.body;
  }

  it('renders the diagram in the summary disclosure, above the quality review', () => {
    const body = summaryBody();
    expect(body).toContain('## Diagram');
    expect(body).toContain('```mermaid\ngraph LR\n  A[Task] --> B[Draft spec]\n```');
    expect(body.indexOf('## Diagram')).toBeLessThan(body.indexOf('## Quality review'));
    // The prose preview itself still skips fences.
    expect(buildSpecSummary(specBody)).not.toContain('mermaid');
  });

  it('does not duplicate a diagram the head-slice fallback already carried', () => {
    const onlyFence = '```mermaid\ngraph LR\n  A --> B\n```';
    const body = summaryBody({ specBody: onlyFence, specSummary: buildSpecSummary(onlyFence) });
    expect(body.match(/```mermaid/g)).toHaveLength(1);
    expect(body).not.toContain('## Diagram');
  });

  it('omits the diagram heading when the spec draws none', () => {
    expect(summaryBody({ specBody: '# Spec\n\nprose only.' })).not.toContain('## Diagram');
  });
});

describe('the affected-components section', () => {
  const affected = (over: Record<string, unknown> = {}) => ({
    ...detectedStub(),
    affectedComponents: {
      named: [{ id: 'n1', title: 'Mailer' }],
      reached: [
        { id: 'n2', title: 'SMTP transport', depth: 1, via: 'depends_on' },
        { id: 'n3', title: 'Theme contract', depth: 2, via: 'affects' },
      ],
      truncated: null,
      mermaid: 'flowchart LR\n  a --> b',
      ...over,
    },
  });

  const sectionBody = (detected: ReturnType<typeof affected>): string => {
    const schema = gate1SpecApprovalStep.form!(makeApplyCtx().ctx, detected) as FormSchema;
    const section = schema.infoSections?.find((s) => s.title === 'Affected components');
    expect(section).toBeDefined();
    return section!.body;
  };

  it('lists what the spec named and what it reaches, and fences the diagram', () => {
    const body = sectionBody(affected());
    expect(body).toContain('Mailer');
    expect(body).toContain('SMTP transport — depends on (1 hop)');
    expect(body).toContain('Theme contract — affects (2 hops)');
    expect(body).toContain('```mermaid');
  });

  it('says how much the diagram left out', () => {
    // The picture is bounded so it stays readable; silence here would let a
    // partial diagram read as the whole blast radius.
    const body = sectionBody(affected({ mermaidOmitted: 7 }));
    expect(body).toMatch(/7 further components .* listed above rather than drawn/);
  });

  it('says nothing when the diagram drew everything', () => {
    expect(sectionBody(affected({ mermaidOmitted: 0 }))).not.toContain('rather than drawn');
  });

  it('still renders output written before the diagram was bounded', () => {
    // This shape is PERSISTED in task_steps.output. A gate parked under the old
    // shape has no mermaidOmitted at all, and must not render a broken line.
    const body = sectionBody(affected());
    expect(body).toContain('```mermaid');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('rather than drawn');
  });

  it('still states a traversal cap, which is a different fact', () => {
    // The walk stopping and the picture being bounded are two separate limits;
    // one must not hide the other.
    const body = sectionBody(
      affected({ truncated: { reason: 'depth', limit: 3 }, mermaidOmitted: 4 }),
    );
    expect(body).toContain('stopped at the depth limit of 3');
    expect(body).toContain('rather than drawn');
  });
});
