import { describe, expect, it } from 'vitest';
import { extractFormDefaults, validateFormValues } from '@haive/shared';
import { normalizeStepFormValues, PLAN_CHAT_MESSAGE_MAX_CHARS } from '@haive/shared/schemas';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { planChatStep } from './01-plan-chat.js';

const oversized = 'x'.repeat(PLAN_CHAT_MESSAGE_MAX_CHARS + 1);
type Detected = Parameters<NonNullable<typeof planChatStep.form>>[1];
const detected = (pendingQuestion: string | null): Detected => ({
  repositoryId: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeId: 'aaaaaaaa-0000-4000-8000-000000000002',
  nodeTitle: 'Mailer',
  nodeVersion: 1,
  planMarkdown: '',
  transcript: [],
  pendingQuestion,
});

describe.each([
  ['normal', null],
  ['stored-message edit', oversized],
] as const)('plan chat %s submission', (_name, pendingQuestion) => {
  const d = detected(pendingQuestion);
  const form = planChatStep.form!({} as never, d)!;
  const validate = (values: Record<string, unknown>) => {
    const expanded = validateFormValues(form, values);
    return expanded.success ? normalizeStepFormValues('01-plan-chat', expanded.data) : expanded;
  };
  const apply = async (values: Record<string, unknown>) => {
    const validated = validate(values);
    expect(validated.success).toBe(true);
    if (!validated.success) throw new Error(validated.issues.join('; '));
    const fake = createFakeDb({ planNodeMessages: schema.planNodeMessages });
    const output = await planChatStep.apply(
      { db: fake.db, taskId: 'aaaaaaaa-0000-4000-8000-000000000003' } as never,
      { detected: d, formValues: validated.data, iteration: 0, previousIterations: [] },
    );
    return { output, messages: await fake.db.select().from(schema.planNodeMessages) };
  };

  it.each(['', null, ' \n\t'])(
    'ends the conversation on blank %j after validation',
    async (message) => {
      const { output, messages } = await apply({ message });
      expect(output.error).toBeNull();
      expect(output.continueRequested).toBe(false);
      expect(planChatStep.reviseLoop!.evaluate(output)).toBeNull();
      expect(messages.filter((m) => m.role === 'user')).toEqual([]);
      if (pendingQuestion) expect(messages[0]?.body).toContain('Conversation ended.');
    },
  );

  it('refuses an oversized edited message after validation', () => {
    expect(validate({ message: oversized }).success).toBe(false);
  });

  it('records a valid edited message and schedules its answer', async () => {
    const { output, messages } = await apply({ message: '  Split the mailer  ' });
    expect(output.continueRequested).toBe(true);
    expect(messages).toMatchObject([{ role: 'user', body: 'Split the mailer' }]);
    expect(planChatStep.reviseLoop!.evaluate(output)).toEqual({ targetStepId: '01-plan-chat' });
  });

  it('has no implicit answer in its defaults', () => {
    const defaults = extractFormDefaults(form);
    expect(defaults).toEqual({});
    expect(validate(defaults).success).toBe(true);
  });
});
