import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FormSchema } from '@haive/shared';
import { FormRenderer } from './form-renderer';

const schema: FormSchema = {
  title: 'Statistics',
  description: 'How the statistics pages behave.',
  fields: [],
};

describe('FormRenderer title', () => {
  it('shows the form title by default', () => {
    const html = renderToStaticMarkup(<FormRenderer schema={schema} onSubmit={() => {}} />);
    expect(html).toContain('<h3');
    expect(html).toContain('How the statistics pages behave.');
  });

  it('hides only the title when asked, keeping the description', () => {
    const html = renderToStaticMarkup(
      <FormRenderer schema={schema} onSubmit={() => {}} hideTitle />,
    );
    expect(html).not.toContain('<h3');
    expect(html).toContain('How the statistics pages behave.');
  });
});
