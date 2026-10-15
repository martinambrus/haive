import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FormSchema } from '@haive/shared';
import { FormRenderer } from './form-renderer';
import { validateRequired } from './form-validation';

const schema: FormSchema = {
  title: 'Draft a task type',
  fields: [
    { type: 'textarea', id: 'message', label: 'Next message' },
    { type: 'textarea', id: 'draft', label: 'Editor state', hidden: true },
  ],
};

const render = (value: FormSchema) =>
  renderToStaticMarkup(<FormRenderer schema={value} onSubmit={() => {}} />);

describe('FormRenderer with a hidden textarea', () => {
  it('renders the field next to it and not the hidden one', () => {
    const html = render(schema);
    expect(html).toContain('Next message');
    expect(html).toContain('id="message"');
    expect(html).not.toContain('Editor state');
    expect(html).not.toContain('id="draft"');
    expect(html.match(/<textarea/g)).toHaveLength(1);
  });

  it('renders a textarea that is not marked hidden, or marked hidden: false', () => {
    const shown: FormSchema = {
      title: 't',
      fields: [
        { type: 'textarea', id: 'a', label: 'Plain' },
        { type: 'textarea', id: 'b', label: 'Explicit', hidden: false },
      ],
    };
    expect(render(shown).match(/<textarea/g)).toHaveLength(2);
  });

  it('does not render a hidden textarea inside an accordion item either', () => {
    const nested: FormSchema = {
      title: 't',
      fields: [
        {
          type: 'accordion',
          id: 'group',
          label: 'Group',
          items: [
            {
              title: 'Item',
              defaultOpen: true,
              fields: [
                { type: 'textarea', id: 'visible', label: 'Visible note' },
                { type: 'textarea', id: 'secret', label: 'Secret note', hidden: true },
              ],
            },
          ],
        },
      ],
    };
    const html = render(nested);
    expect(html).toContain('Visible note');
    expect(html).not.toContain('Secret note');
  });

  it('does not hold a required hidden textarea against the person who cannot see it', () => {
    const required: FormSchema = {
      title: 't',
      fields: [
        { type: 'textarea', id: 'draft', label: 'Editor state', required: true, hidden: true },
      ],
    };
    expect(validateRequired(required, {})).toBeNull();
    expect(render(required)).not.toContain('Editor state');
  });
});
