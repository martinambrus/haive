import { describe, expect, it } from 'vitest';
import { setSummaryCliRequestSchema } from '../src/schemas/tasks.js';

// The recap provider used to be settable only on the New Task form, so a task whose summary
// CLI turned out to be wrong had no way back — MEASURED on 2026-09-13, a task's recap ran on
// amp, amp's session expired mid-run, and nothing in the product could repoint it.
describe('setSummaryCliRequestSchema', () => {
  it('takes either field alone, so one can change without touching the other', () => {
    expect(setSummaryCliRequestSchema.parse({ summaryLlmEnabled: false })).toEqual({
      summaryLlmEnabled: false,
    });
    const id = '00000000-0000-4000-8000-000000000000';
    expect(setSummaryCliRequestSchema.parse({ summaryCliProviderId: id })).toEqual({
      summaryCliProviderId: id,
    });
  });

  it('keeps an explicit null distinct from an omitted field', () => {
    // null is a REAL choice — inherit the step's own chain — and the route writes the
    // choice-recorded bit for it. Omitting the field means "leave the setting alone", which
    // is why the two must not collapse.
    const parsed = setSummaryCliRequestSchema.parse({ summaryCliProviderId: null });
    expect(parsed).toHaveProperty('summaryCliProviderId', null);
    expect(setSummaryCliRequestSchema.parse({ summaryLlmEnabled: true })).not.toHaveProperty(
      'summaryCliProviderId',
    );
  });

  it('refuses a body that changes nothing', () => {
    expect(() => setSummaryCliRequestSchema.parse({})).toThrow();
  });

  it('refuses a provider id that is not a uuid', () => {
    expect(() => setSummaryCliRequestSchema.parse({ summaryCliProviderId: 'amp' })).toThrow();
  });
});
