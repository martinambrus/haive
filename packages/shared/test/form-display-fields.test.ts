import { describe, expect, it } from 'vitest';
import { validateFormValues } from '../src/step-engine/schemas.js';
import type { FormSchema } from '../src/schemas/form.js';

const schema: FormSchema = {
  title: 'Review proposed corrections',
  fields: [
    { type: 'note', id: 'reopenedFormNotice', label: 'Notice', body: 'Refused once.' },
    { type: 'text', id: 'formToken', label: 'formToken', hidden: true, default: 't1' },
    { type: 'note', id: 'counts', label: 'Pending', body: '3 corrections await a decision.' },
    {
      type: 'multi-select',
      id: 'approved',
      label: 'Corrections to apply',
      required: false,
      defaults: [],
      options: [{ value: 'p1', label: 'one' }],
    },
  ],
};

describe('display-only fields in submitted answers', () => {
  it('adds no key for a note the page did not send', () => {
    const result = validateFormValues(schema, { formToken: 't1', approved: ['p1'] });
    expect(result).toEqual({ success: true, data: { formToken: 't1', approved: ['p1'] } });
  });

  it('drops a value sent for a note', () => {
    const result = validateFormValues(schema, { formToken: 't1', approved: [], counts: 'x' });
    expect(result).toEqual({ success: true, data: { formToken: 't1', approved: [] } });
  });
});
