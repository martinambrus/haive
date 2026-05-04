import { describe, expect, it } from 'vitest';
import { radioWithTextareaFieldSchema, formSchemaSchema } from '../src/schemas/form.js';

describe('radioWithTextareaFieldSchema', () => {
  const minimal = {
    type: 'radio-with-textarea' as const,
    id: 'q1',
    label: 'Pick one',
    predefined: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  };

  it('accepts a minimal field with predefined options', () => {
    const parsed = radioWithTextareaFieldSchema.parse(minimal);
    expect(parsed.type).toBe('radio-with-textarea');
    expect(parsed.predefined).toHaveLength(2);
  });

  it('accepts an empty predefined array (only the custom radio is shown)', () => {
    const parsed = radioWithTextareaFieldSchema.parse({ ...minimal, predefined: [] });
    expect(parsed.predefined).toEqual([]);
  });

  it('accepts customLabel, default, placeholder, rows', () => {
    const parsed = radioWithTextareaFieldSchema.parse({
      ...minimal,
      customLabel: 'Other',
      default: 'yes',
      placeholder: 'Type here...',
      rows: 6,
    });
    expect(parsed.customLabel).toBe('Other');
    expect(parsed.default).toBe('yes');
    expect(parsed.placeholder).toBe('Type here...');
    expect(parsed.rows).toBe(6);
  });

  it('rejects a missing predefined array', () => {
    const { predefined: _omit, ...without } = minimal;
    expect(() => radioWithTextareaFieldSchema.parse(without)).toThrow();
  });

  it('rejects a non-string default', () => {
    expect(() => radioWithTextareaFieldSchema.parse({ ...minimal, default: 42 })).toThrow();
  });

  it('rejects a non-positive rows value', () => {
    expect(() => radioWithTextareaFieldSchema.parse({ ...minimal, rows: 0 })).toThrow();
    expect(() => radioWithTextareaFieldSchema.parse({ ...minimal, rows: -3 })).toThrow();
  });

  it('parses inside a full FormSchema discriminated union', () => {
    const parsed = formSchemaSchema.parse({
      title: 'Q&A',
      fields: [minimal],
    });
    expect(parsed.fields[0]!.type).toBe('radio-with-textarea');
  });
});
