import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formSchemaSchema } from '@haive/shared/schemas';
import { FormRenderer } from './form-renderer';

const schema = formSchemaSchema.parse({
  title: 'Edit message',
  fields: [{ type: 'textarea', id: 'message', label: 'Message', initialValue: 'Original message' }],
});

describe('textarea initialValue', () => {
  it('prefills an editable textarea with the complete original', () => {
    const html = renderToStaticMarkup(<FormRenderer schema={schema} onSubmit={() => {}} />);
    expect(html).toMatch(/<textarea[^>]*>Original message<\/textarea>/);
    expect(html).not.toContain('readonly');
  });

  it('keeps a cleared value empty instead of restoring the original', () => {
    const html = renderToStaticMarkup(
      <FormRenderer schema={schema} initialValues={{ message: '' }} onSubmit={() => {}} />,
    );
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).not.toContain('Original message');
  });
});
