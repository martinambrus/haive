import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptStepEditor } from './prompt-step-editor';

const entry = {
  slug: 'a',
  title: 'Check <b>it</b>',
  template: 'Review {{task.title}}',
  capabilities: ['file_write' as const],
  tools: [],
  timeoutMs: 600_000,
};
const noop = () => {};

describe('PromptStepEditor', () => {
  const html = renderToStaticMarkup(
    <PromptStepEditor entry={entry} onChange={noop} onRemove={noop} />,
  );

  it('shows the title, the template in a monospace textarea and the timeout in minutes', () => {
    expect(html).toContain('Prompt template');
    expect(html).toMatch(/<textarea[^>]*font-mono[^>]*>Review \{\{task.title\}\}<\/textarea>/);
    expect(html).toContain('value="10"');
    expect(html).toContain('Timeout (minutes)');
    expect(html).toContain('value="Check &lt;b&gt;it&lt;/b&gt;"');
  });

  it("lists the three capabilities with the entry's ticked", () => {
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('Can use tools');
    expect(html).toContain('Can write files');
    expect(html).toContain('Can read images');
  });

  it('explains the tokens on one help line, as markdown', () => {
    for (const token of [
      '{{task.title}}',
      '{{task.description}}',
      '{{step:&lt;id&gt;}}',
      '{{agent:&lt;id&gt;}}',
      '{{integration:&lt;id&gt;.account}}',
    ]) {
      expect(html).toContain(`<code>${token}</code>`);
    }
  });

  it('offers the field token only to a step that declares a form', () => {
    expect(html).not.toContain('{{field:');
    const withForm = renderToStaticMarkup(
      <PromptStepEditor
        entry={{ ...entry, paramFormSchema: { title: 'f', fields: [] } }}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(withForm).toContain('<code>{{field:&lt;id&gt;}}</code>');
  });

  it('takes a timeout in fractions of a minute', () => {
    expect(html).toMatch(/<input[^>]*id="prompt-step-a-timeout"[^>]*step="any"/);
  });

  it('has a Remove control, and makes everything inert while disabled', () => {
    expect(html).toContain('Remove prompt step');
    const off = renderToStaticMarkup(
      <PromptStepEditor entry={entry} disabled onChange={noop} onRemove={noop} />,
    );
    const controls = off.match(/<(button|input|textarea)\b[^>]*>/g) ?? [];
    expect(controls.length).toBe(8);
    for (const tag of controls) expect(tag).toContain('disabled=""');
  });
});
