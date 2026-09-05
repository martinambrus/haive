import { describe, it, expect } from 'vitest';
import type { FormSchema } from '@haive/shared';
import { validateRequired } from './form-validation';

/** The shape that fails without a visibility check: a required text field the
 *  renderer hides. Submitting was blocked by an error naming a field that is not
 *  on screen, with nothing the user could do about it. */
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

describe('validateRequired honors visibleWhen', () => {
  it('does not require a field the predicate hides', () => {
    expect(validateRequired(gateSchema, { push: false })).toBeNull();
  });

  it('still requires the field once the predicate shows it', () => {
    expect(validateRequired(gateSchema, { push: true })).toBe('Origin remote URL is required');
  });

  it('accepts the field when shown and supplied', () => {
    expect(
      validateRequired(gateSchema, { push: true, remoteUrl: 'https://e.com/r.git' }),
    ).toBeNull();
  });

  it('leaves an ungated required field enforced', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
    };
    expect(validateRequired(schema, {})).toBe('Name is required');
  });

  it('honors an `in` set — the RAG connection string shape', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        {
          type: 'text',
          id: 'ragConnectionString',
          label: 'PostgreSQL connection string',
          required: true,
          visibleWhen: { field: 'ragMode', in: ['ddev', 'external'] },
        },
        { type: 'text', id: 'ragMode', label: 'Mode' },
      ],
    };
    expect(validateRequired(schema, { ragMode: 'internal' })).toBeNull();
    expect(validateRequired(schema, { ragMode: 'none' })).toBeNull();
    expect(validateRequired(schema, { ragMode: 'ddev' })).toBe(
      'PostgreSQL connection string is required',
    );
    expect(
      validateRequired(schema, { ragMode: 'ddev', ragConnectionString: 'postgres://h/d' }),
    ).toBeNull();
  });
});
