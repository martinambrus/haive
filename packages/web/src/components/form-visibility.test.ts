import { describe, it, expect } from 'vitest';
import type { FormField } from '@haive/shared';
import { isFieldVisible } from './form-visibility';

const field = (visibleWhen?: FormField['visibleWhen']): FormField =>
  ({ type: 'checkbox', id: 'x', label: 'X', visibleWhen }) as FormField;

describe('isFieldVisible', () => {
  it('shows a field with no visibleWhen', () => {
    expect(isFieldVisible(field(), { mode: 'skip' })).toBe(true);
  });

  it('notEquals: hidden when the watched field equals the value', () => {
    const f = field({ field: 'mode', notEquals: 'skip' });
    expect(isFieldVisible(f, { mode: 'skip' })).toBe(false);
    expect(isFieldVisible(f, { mode: 'headless' })).toBe(true);
    expect(isFieldVisible(f, {})).toBe(true); // undefined !== 'skip'
  });

  it('equals: shown only when the watched field matches', () => {
    const f = field({ field: 'mode', equals: 'mcp' });
    expect(isFieldVisible(f, { mode: 'mcp' })).toBe(true);
    expect(isFieldVisible(f, { mode: 'headless' })).toBe(false);
  });
});
