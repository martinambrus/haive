import { describe, expect, it } from 'vitest';
import { normalizeStepFormValues } from '../src/schemas/step-form-values.js';
import { formSchemaSchema } from '../src/schemas/form.js';
import { extractFormDefaults, validateFormValues } from '../src/step-engine/schemas.js';

describe('plan chat blank form values', () => {
  const normal = formSchemaSchema.parse({
    title: 'Conversation',
    fields: [{ type: 'textarea', id: 'message', label: 'Message' }],
  });

  it.each(['', null, undefined, ' \n\t'])('accepts blank input %j after validation', (message) => {
    const validated = validateFormValues(normal, { message });
    expect(validated.success).toBe(true);
    if (!validated.success) throw new Error(validated.issues.join('; '));
    expect(normalizeStepFormValues('01-plan-chat', validated.data).success).toBe(true);
  });

  it('keeps null, empty and omitted pre-answers or saved answers safe', () => {
    for (const values of [{ message: null }, { message: '' }, {}]) {
      expect(normalizeStepFormValues('01-plan-chat', values)).toEqual({
        success: true,
        data: values,
      });
    }
  });

  it('does not turn an editor initial value into a validation or auto-submit default', () => {
    const edit = formSchemaSchema.parse({
      title: 'Edit',
      fields: [{ type: 'textarea', id: 'message', label: 'Message', initialValue: 'Original' }],
    });
    expect(edit.fields[0]).toHaveProperty('initialValue', 'Original');
    expect(extractFormDefaults(edit)).toEqual({});
    expect(validateFormValues(edit, { message: '' })).toEqual({
      success: true,
      data: { message: null },
    });
  });

  it('retains fallback defaults for existing textarea fields', () => {
    const existing = formSchemaSchema.parse({
      title: 'Other step',
      fields: [{ type: 'textarea', id: 'body', label: 'Body', default: 'Fallback' }],
    });
    expect(validateFormValues(existing, { body: '' })).toEqual({
      success: true,
      data: { body: 'Fallback' },
    });
  });

  it.each([42, false, [], {}])('still refuses a non-string message %j', (message) => {
    expect(normalizeStepFormValues('01-plan-chat', { message }).success).toBe(false);
  });
});
