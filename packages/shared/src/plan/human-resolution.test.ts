import { describe, expect, it } from 'vitest';
import { formSchemaSchema } from '../schemas/form.js';
import { resolvePlanNodeRequestSchema } from '../schemas/plan.js';
import { appendPlanAnswer, humanPlanAction, planResolutionForm } from './human-resolution.js';

describe('human plan resolutions', () => {
  it('distinguishes a human decision from developer work and research', () => {
    expect(humanPlanAction({ kind: 'decision', taskable: false })).toBe('decision');
    expect(humanPlanAction({ kind: 'decision', taskable: true })).toBeNull();
    expect(humanPlanAction({ kind: 'component', taskable: false })).toBeNull();
    expect(humanPlanAction({ kind: 'research', taskable: false })).toBeNull();
    expect(humanPlanAction({ kind: 'external', taskable: true })).toBe('outcome');
  });

  it('preserves the original question and previous answer exactly', () => {
    const body = '  Original question.\n\n## Decision\n\nAn earlier answer.\n';
    expect(appendPlanAnswer(body, 'decision', '  The revised answer.  ')).toBe(
      `${body}\n\n## Decision\n\nThe revised answer.`,
    );
    expect(appendPlanAnswer(null, 'outcome', 'Hosting is ready.')).toBe(
      '## Outcome\n\nHosting is ready.',
    );
  });

  it('keeps an appended answer outside an unclosed four-backtick or tilde fence', () => {
    for (const fence of ['````', '~~~']) {
      const body = `Question:\n${fence}text\nquoted example\n\u0060\u0060\u0060`;
      expect(appendPlanAnswer(body, 'decision', 'Chosen.')).toBe(
        `${body}\n${fence}\n\n## Decision\n\nChosen.`,
      );
    }
  });

  it('shows the question and requires an answer and explicit completion choice', () => {
    const form = planResolutionForm({
      title: 'Revision meaning',
      kind: 'decision',
      taskable: false,
      body: 'Inspection or version?',
      status: 'todo',
    });
    expect(formSchemaSchema.safeParse(form).success).toBe(true);
    expect(form.fields[0]).toMatchObject({ type: 'note', body: 'Inspection or version?' });
    expect(form.fields[1]).toMatchObject({ id: 'answer', required: true });
    expect(form.fields[2]).toMatchObject({
      id: 'status',
      default: 'blocked_human',
      options: [{ value: 'done' }, { value: 'blocked_human' }, { value: 'not_applicable' }],
    });
  });

  it('keeps the settled status when adding details to an existing outcome', () => {
    const form = planResolutionForm({
      title: 'Hosting',
      kind: 'external',
      taskable: false,
      body: null,
      status: 'done',
    });
    expect(form.title).toBe('Record outcome');
    expect(form.fields[2]).toMatchObject({ default: 'done' });
  });

  it('refuses an empty answer, unsupported status or missing concurrency version', () => {
    const request = { answer: 'Inspection records', expectedVersion: 1, status: 'done' };
    expect(resolvePlanNodeRequestSchema.safeParse(request).success).toBe(true);
    for (const invalid of [
      { ...request, answer: '  ' },
      { ...request, status: 'todo' },
      { ...request, expectedVersion: undefined },
    ]) {
      expect(resolvePlanNodeRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
