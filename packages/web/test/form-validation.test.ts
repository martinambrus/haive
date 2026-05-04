import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import { validateRequired } from '../src/components/form-validation.js';

function schema(...fields: FormSchema['fields']): FormSchema {
  return { title: 't', fields };
}

describe('validateRequired', () => {
  it('returns null when no fields are required', () => {
    const s = schema({ type: 'text', id: 'a', label: 'A' });
    expect(validateRequired(s, {})).toBeNull();
  });

  it('skips non-required fields even if empty', () => {
    const s = schema({ type: 'text', id: 'a', label: 'A' });
    expect(validateRequired(s, { a: '' })).toBeNull();
  });

  it('enforces required checkbox must be true', () => {
    const s = schema({ type: 'checkbox', id: 'ack', label: 'Confirm', required: true });
    expect(validateRequired(s, { ack: false })).toBe('Confirm is required');
    expect(validateRequired(s, { ack: true })).toBeNull();
    expect(validateRequired(s, {})).toBe('Confirm is required');
  });

  it('enforces required multi-select must be non-empty array', () => {
    const s = schema({
      type: 'multi-select',
      id: 'tags',
      label: 'Tags',
      required: true,
      options: [{ value: 'x', label: 'X' }],
    });
    expect(validateRequired(s, { tags: [] })).toBe('Tags is required');
    expect(validateRequired(s, { tags: ['x'] })).toBeNull();
    expect(validateRequired(s, { tags: 'x' as unknown })).toBe('Tags is required');
  });

  it('enforces required directory-tree same as multi-select', () => {
    const s = schema({
      type: 'directory-tree',
      id: 'dirs',
      label: 'Dirs',
      required: true,
      tree: { name: 'root', path: '', type: 'dir', children: [] },
    });
    expect(validateRequired(s, { dirs: [] })).toBe('Dirs is required');
    expect(validateRequired(s, { dirs: ['a'] })).toBeNull();
  });

  it('enforces required number rejects empty, null, undefined, NaN', () => {
    const s = schema({ type: 'number', id: 'n', label: 'N', required: true });
    expect(validateRequired(s, { n: '' })).toBe('N is required');
    expect(validateRequired(s, { n: null })).toBe('N is required');
    expect(validateRequired(s, {})).toBe('N is required');
    expect(validateRequired(s, { n: Number.NaN })).toBe('N is required');
    expect(validateRequired(s, { n: 0 })).toBeNull();
    expect(validateRequired(s, { n: 42 })).toBeNull();
  });

  it('enforces required text/textarea/select must be non-empty string', () => {
    const s = schema(
      { type: 'text', id: 'a', label: 'A', required: true },
      { type: 'textarea', id: 'b', label: 'B', required: true },
    );
    expect(validateRequired(s, { a: '', b: 'ok' })).toBe('A is required');
    expect(validateRequired(s, { a: '  ', b: 'ok' })).toBe('A is required');
    expect(validateRequired(s, { a: 'ok', b: '' })).toBe('B is required');
    expect(validateRequired(s, { a: 'ok', b: 'ok' })).toBeNull();
  });

  it('enforces required radio-with-textarea must be non-empty string (predefined or custom)', () => {
    const s = schema({
      type: 'radio-with-textarea',
      id: 'q',
      label: 'Q',
      required: true,
      predefined: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    expect(validateRequired(s, { q: '' })).toBe('Q is required');
    expect(validateRequired(s, { q: '   ' })).toBe('Q is required');
    expect(validateRequired(s, {})).toBe('Q is required');
    expect(validateRequired(s, { q: 'yes' })).toBeNull();
    expect(validateRequired(s, { q: 'custom answer text' })).toBeNull();
  });

  it('skips non-required radio-with-textarea even if empty', () => {
    const s = schema({
      type: 'radio-with-textarea',
      id: 'q',
      label: 'Q',
      predefined: [{ value: 'yes', label: 'Yes' }],
    });
    expect(validateRequired(s, { q: '' })).toBeNull();
    expect(validateRequired(s, {})).toBeNull();
  });

  it('returns the first missing field in declaration order', () => {
    const s = schema(
      { type: 'text', id: 'a', label: 'A', required: true },
      { type: 'checkbox', id: 'b', label: 'B', required: true },
    );
    expect(validateRequired(s, { a: '', b: false })).toBe('A is required');
    expect(validateRequired(s, { a: 'x', b: false })).toBe('B is required');
  });
});
