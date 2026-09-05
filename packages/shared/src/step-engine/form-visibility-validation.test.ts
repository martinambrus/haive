import { describe, it, expect } from 'vitest';
import type { FormSchema } from '../schemas/form.js';
import { isFieldVisible } from '../schemas/form.js';
import { validateFormValues } from './schemas.js';

/** The exact shape that failed a live task: a required text field gated behind an
 *  unticked checkbox (11a-gate-4-push's `remoteUrl` behind `push`). */
const gateSchema: FormSchema = {
  title: 'Gate 4: Push',
  fields: [
    {
      type: 'text',
      id: 'remoteUrl',
      label: 'Origin remote URL',
      required: true,
      visibleWhen: { field: 'push', equals: true },
    },
    { type: 'checkbox', id: 'push', label: 'Add origin and push', default: false },
  ],
};

describe('validateFormValues honors visibleWhen', () => {
  it('does not require a field the predicate hides', () => {
    // Declining the push is an input 11a-gate-4-push's apply() explicitly handles
    // (`if (!values.push) return ... 'push skipped'`). Before the fix this failed with
    // `remoteUrl: required` and took the whole task to `failed`.
    const res = validateFormValues(gateSchema, { push: false });
    expect(res.success).toBe(true);
  });

  it('still requires the field once the predicate shows it', () => {
    const res = validateFormValues(gateSchema, { push: true });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues).toContain('remoteUrl: required');
  });

  it('accepts the field when shown and supplied', () => {
    const res = validateFormValues(gateSchema, {
      push: true,
      remoteUrl: 'https://example.com/o/r.git',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.remoteUrl).toBe('https://example.com/o/r.git');
  });

  it('leaves an ungated required field enforced', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
    };
    const res = validateFormValues(schema, {});
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues).toContain('name: required');
  });

  it('honors notEquals gating', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        {
          type: 'text',
          id: 'reason',
          label: 'Reason',
          required: true,
          visibleWhen: { field: 'mode', notEquals: 'skip' },
        },
        { type: 'text', id: 'mode', label: 'Mode' },
      ],
    };
    expect(validateFormValues(schema, { mode: 'skip' }).success).toBe(true);
    expect(validateFormValues(schema, { mode: 'run' }).success).toBe(false);
  });

  it('honors `in` gating across several choices of one select', () => {
    // 04-tooling-infrastructure's shape: one connection string that two of the four
    // RAG modes need and the other two must not be asked for.
    const schema: FormSchema = {
      title: 't',
      fields: [
        {
          type: 'text',
          id: 'ragConnectionString',
          label: 'Connection string',
          required: true,
          visibleWhen: { field: 'ragMode', in: ['ddev', 'external'] },
        },
        { type: 'text', id: 'ragMode', label: 'Mode' },
      ],
    };
    expect(validateFormValues(schema, { ragMode: 'internal' }).success).toBe(true);
    expect(validateFormValues(schema, { ragMode: 'none' }).success).toBe(true);
    expect(validateFormValues(schema, { ragMode: 'ddev' }).success).toBe(false);
    expect(validateFormValues(schema, { ragMode: 'external' }).success).toBe(false);
    expect(
      validateFormValues(schema, { ragMode: 'ddev', ragConnectionString: 'postgres://h/d' })
        .success,
    ).toBe(true);
  });
});

describe('isFieldVisible', () => {
  const f = (vw?: {
    field: string;
    equals?: string | boolean;
    notEquals?: string | boolean;
    in?: string[];
  }) => ({ visibleWhen: vw });

  it('shows a field with no predicate', () => {
    expect(isFieldVisible(f(), {})).toBe(true);
  });

  it('compares with strict equality, so booleans and strings do not cross over', () => {
    expect(isFieldVisible(f({ field: 'p', equals: true }), { p: true })).toBe(true);
    expect(isFieldVisible(f({ field: 'p', equals: true }), { p: 'true' })).toBe(false);
  });

  it('treats an absent parent value as not matching an equals predicate', () => {
    expect(isFieldVisible(f({ field: 'p', equals: true }), {})).toBe(false);
  });

  it('matches any member of an `in` set, and nothing else', () => {
    const vw = { field: 'p', in: ['ddev', 'external'] };
    expect(isFieldVisible(f(vw), { p: 'ddev' })).toBe(true);
    expect(isFieldVisible(f(vw), { p: 'external' })).toBe(true);
    expect(isFieldVisible(f(vw), { p: 'internal' })).toBe(false);
    // Absent, and non-string values, must not match — `in` is string-only.
    expect(isFieldVisible(f(vw), {})).toBe(false);
    expect(isFieldVisible(f({ field: 'p', in: ['true'] }), { p: true })).toBe(false);
  });
});
