import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DerivedTaskWarnings } from './derived-task-warnings';
import { MarkdownView } from './markdown/markdown-view';
import { InlineMarkdown } from './markdown/inline-markdown';

describe('historical derived warnings', () => {
  it('renders pinned target/path and obsolete-default notices through markdown', () => {
    const html = renderToStaticMarkup(
      <DerivedTaskWarnings
        warnings={[
          {
            kind: 'stale-target',
            stepId: 'old-step',
            operationIndex: 1,
            candidates: [null, 'quick_bugfix'],
          },
          {
            kind: 'path-absent-replacement',
            stepId: 'b',
            operationIndex: 2,
            candidates: ['quick_bugfix'],
          },
          { kind: 'default-key-not-in-steps', stepId: 'gone', field: 'preAnswerDefaults' },
        ]}
      />,
    );
    expect(html).toContain('Base no longer includes this step');
    expect(html).toContain('pre-triage, quick_bugfix');
    expect(html).toContain('Replacement skipped on this path');
    expect(html).toContain('obsolete and was omitted');
    expect(html).toContain('haive-md');
    expect(InlineMarkdown({ body: 'warning' }).props.children.type).toBe(MarkdownView);
  });
  it('adds no UI to existing tasks with no warnings', () => {
    expect(renderToStaticMarkup(<DerivedTaskWarnings />)).toBe('');
    expect(renderToStaticMarkup(<DerivedTaskWarnings warnings={[]} />)).toBe('');
  });
});
