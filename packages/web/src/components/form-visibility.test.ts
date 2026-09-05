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

  it('equals: boolean gates a sub-field on a checkbox (e.g. push under commit)', () => {
    const f = field({ field: 'commit', equals: true });
    expect(isFieldVisible(f, { commit: true })).toBe(true);
    expect(isFieldVisible(f, { commit: false })).toBe(false);
    expect(isFieldVisible(f, {})).toBe(false); // undefined !== true → hidden until ticked
  });

  it('in: shown for any member of the set (RAG connection string)', () => {
    const f = field({ field: 'ragMode', in: ['ddev', 'external'] });
    expect(isFieldVisible(f, { ragMode: 'ddev' })).toBe(true);
    expect(isFieldVisible(f, { ragMode: 'external' })).toBe(true);
    expect(isFieldVisible(f, { ragMode: 'internal' })).toBe(false);
    expect(isFieldVisible(f, {})).toBe(false);
  });
});
