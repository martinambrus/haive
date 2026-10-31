import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewRepoForm } from './new-repo-form';

// The server renders this form, and a browser submits it natively until React attaches
// handleSubmit. Its inputs carry names, so without method="post" that submit is a GET, which puts
// the display name, branch and writable choice in the URL, the history and every access log. Next
// answers a urlencoded POST on this route and refuses a multipart one, so the form must also never
// set an enctype. The name, branch and writable fields are uncontrolled: a value attribute is what
// React would reset a typed or ticked field to at its next re-render.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

describe('NewRepoForm, as the server renders it', () => {
  const render = () => renderToStaticMarkup(<NewRepoForm />);
  const inputs = () => render().match(/<input\b[^>]*>/g) ?? [];
  const inputWithId = (id: string) => inputs().find((tag) => tag.includes(`id="${id}"`)) ?? '';

  it('is posted natively and with no enctype', () => {
    const [, attrs = ''] = /<form\b([^>]*)>/.exec(render()) ?? [];

    expect(attrs).toContain('method="post"');
    expect(attrs).not.toMatch(/enctype/i);
  });

  it.each([
    ['repo-name', 'repoName'],
    ['repo-branch', 'branch'],
  ])('leaves #%s uncontrolled and named %s', (id, name) => {
    const tag = inputWithId(id);

    expect(tag).toContain(`name="${name}"`);
    expect(tag).not.toMatch(/\svalue=/);
  });

  it('names the writable checkbox', () => {
    const tag = inputs().find((input) => input.includes('type="checkbox"')) ?? '';

    expect(tag).toContain('name="writable"');
  });
});
