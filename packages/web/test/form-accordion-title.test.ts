import { describe, expect, it } from 'vitest';
import type { FormField } from '@haive/shared';
import { accordionItemTitle } from '../src/components/form-accordion-title.js';

type AccordionItem = Extract<FormField, { type: 'accordion' }>['items'][number];

const dimensions: AccordionItem = {
  title: 'Dimensions scored',
  titleCountFieldId: 'reviewDimensions',
  fields: [
    {
      type: 'multi-select',
      id: 'reviewDimensions',
      label: 'Score these dimensions',
      options: [
        { value: 'security', label: 'Security' },
        { value: 'accessibility', label: 'Accessibility' },
        { value: 'testability', label: 'Testability' },
      ],
      defaults: ['security', 'accessibility', 'testability'],
    },
  ],
};

describe('accordionItemTitle', () => {
  it('counts the current selection, not the field defaults', () => {
    expect(accordionItemTitle(dimensions, { reviewDimensions: ['security'] })).toBe(
      'Dimensions scored (1 of 3)',
    );
    expect(accordionItemTitle(dimensions, { reviewDimensions: [] })).toBe(
      'Dimensions scored (0 of 3)',
    );
  });

  it('counts nothing when the value is absent or not a list', () => {
    expect(accordionItemTitle(dimensions, {})).toBe('Dimensions scored (0 of 3)');
    expect(accordionItemTitle(dimensions, { reviewDimensions: 'security' })).toBe(
      'Dimensions scored (0 of 3)',
    );
  });

  // The schema is STORED: an item written before the declaration existed carries the
  // count inside its own title. Appending a second one would render "(14 of 14) (12 of
  // 14)", so an undeclared item must render verbatim.
  it('renders a title with no declaration verbatim', () => {
    const legacy: AccordionItem = { ...dimensions, title: 'Dimensions scored (3 of 3)' };
    delete (legacy as { titleCountFieldId?: string }).titleCountFieldId;
    expect(accordionItemTitle(legacy, { reviewDimensions: ['security'] })).toBe(
      'Dimensions scored (3 of 3)',
    );
  });

  it('renders verbatim when the declaration names a missing or non-multi-select field', () => {
    expect(accordionItemTitle({ ...dimensions, titleCountFieldId: 'nope' }, {})).toBe(
      'Dimensions scored',
    );
    const checkbox: AccordionItem = {
      ...dimensions,
      titleCountFieldId: 'simplify',
      fields: [{ type: 'checkbox', id: 'simplify', label: 'Simplify' }],
    };
    expect(accordionItemTitle(checkbox, { simplify: true })).toBe('Dimensions scored');
  });
});
