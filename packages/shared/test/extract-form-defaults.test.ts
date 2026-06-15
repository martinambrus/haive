import { describe, expect, it } from 'vitest';
import type { FormSchema } from '../src/schemas/form.js';
import { extractFormDefaults, validateFormValues } from '../src/step-engine/schemas.js';

describe('extractFormDefaults', () => {
  it('collects declared defaults across field types', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        { type: 'text', id: 'tag', label: 'Tag', default: 'haive-env:latest', required: true },
        { type: 'checkbox', id: 'force', label: 'Force', default: false },
        {
          type: 'select',
          id: 'mode',
          label: 'Mode',
          options: [{ value: 'a', label: 'A' }],
          default: 'a',
        },
        {
          type: 'multi-select',
          id: 'checks',
          label: 'Checks',
          options: [{ value: 'x', label: 'X' }],
          defaults: ['x'],
        },
      ],
    };
    expect(extractFormDefaults(schema)).toEqual({
      tag: 'haive-env:latest',
      force: false,
      mode: 'a',
      checks: ['x'],
    });
  });

  it('omits fields that have no default', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        { type: 'text', id: 'tag', label: 'Tag', default: 'x' },
        { type: 'text', id: 'name', label: 'Name' },
      ],
    };
    expect(extractFormDefaults(schema)).toEqual({ tag: 'x' });
  });

  it('recurses accordion groups', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        {
          type: 'accordion',
          id: 'acc',
          label: 'Group',
          items: [
            { title: 'g1', fields: [{ type: 'checkbox', id: 'a', label: 'A', default: true }] },
          ],
        },
      ],
    };
    expect(extractFormDefaults(schema)).toEqual({ a: true });
  });

  it('produces a candidate that validates when every required field has a default', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [
        { type: 'text', id: 'tag', label: 'Tag', default: 'haive-env:latest', required: true },
        { type: 'checkbox', id: 'force', label: 'Force', default: false },
      ],
    };
    const result = validateFormValues(schema, extractFormDefaults(schema));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ tag: 'haive-env:latest', force: false });
  });

  it('produces a candidate that fails validation when a required field has no default', () => {
    const schema: FormSchema = {
      title: 't',
      fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
    };
    const result = validateFormValues(schema, extractFormDefaults(schema));
    expect(result.success).toBe(false);
  });
});
