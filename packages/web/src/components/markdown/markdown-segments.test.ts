import { describe, expect, it } from 'vitest';
import { COLLAPSE_LINES, hasCollapsibleContent, segmentMarkdownBody } from './markdown-segments';

const PAIR = ['```before', 'old line', '```', '', '```after', 'new line', '```'].join('\n');

describe('segmentMarkdownBody', () => {
  it('returns a single markdown segment for plain bodies', () => {
    const segments = segmentMarkdownBody('# Spec\n\nprose');
    expect(segments).toEqual([{ kind: 'markdown', text: '# Spec\n\nprose' }]);
  });

  it('pairs adjacent before/after fences and preserves order', () => {
    const body = `# Spec\n\nintro\n\n${PAIR}\n\noutro`;
    const segments = segmentMarkdownBody(body);
    expect(segments.map((s) => s.kind)).toEqual(['markdown', 'before-after', 'markdown']);
    const pair = segments[1] as { kind: 'before-after'; before: string; after: string };
    expect(pair.before).toBe('old line');
    expect(pair.after).toBe('new line');
    expect((segments[0] as { text: string }).text).toContain('intro');
    expect((segments[2] as { text: string }).text).toContain('outro');
  });

  it('does not pair fences separated by prose', () => {
    const body = ['```before', 'a', '```', 'prose between', '```after', 'b', '```'].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe('markdown');
  });

  it('leaves an unpaired before fence in the markdown stream', () => {
    const body = ['```before', 'a', '```', '', 'no after here'].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments).toHaveLength(1);
    expect((segments[0] as { text: string }).text).toContain('```before');
  });

  it('emits a quiz segment for a valid quiz section', () => {
    const body = [
      '# Spec',
      '',
      'prose',
      '',
      '## Comprehension Quiz',
      '### Q1: ok?',
      '- [x] yes',
      '- [ ] no',
    ].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments.map((s) => s.kind)).toEqual(['markdown', 'quiz']);
  });

  it('keeps the quiz text as markdown when parsing fails', () => {
    const body = ['# Spec', '', '## Comprehension Quiz', 'no questions here'].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe('markdown');
    expect((segments[0] as { text: string }).text).toContain('no questions here');
  });

  it('handles the full stub-shaped document', () => {
    const body = [
      '# Spec: x',
      '',
      '## Goal',
      'g',
      '',
      '```mermaid',
      'graph LR',
      '  A --> B',
      '```',
      '',
      PAIR,
      '',
      '## Comprehension Quiz',
      '### Q1: ok?',
      '- [x] yes',
      '- [ ] no',
      '> Explanation: because.',
    ].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments.map((s) => s.kind)).toEqual(['markdown', 'before-after', 'quiz']);
    // The mermaid fence stays inside the first markdown segment untouched.
    expect((segments[0] as { text: string }).text).toContain('```mermaid');
  });

  it('ignores before/after markers nested inside another fence', () => {
    const body = ['````md', '```before', 'x', '```', '````', 'prose'].join('\n');
    const segments = segmentMarkdownBody(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe('markdown');
  });
});

describe('fences read by CommonMark rules', () => {
  it('leaves a before/after pair written inside a four-backtick fence in that fence', () => {
    const body = [
      '````md',
      '```',
      '```before',
      'old',
      '```',
      '```after',
      'new',
      '```',
      '````',
    ].join('\n');
    expect(segmentMarkdownBody(body)).toEqual([{ kind: 'markdown', text: body }]);
  });

  it('pairs tilde fences and fences whose info string goes on past the language', () => {
    const body = ['~~~before', 'old', '~~~', '', '```after title="new"', 'new', '```'].join('\n');
    expect(segmentMarkdownBody(body)).toEqual([
      { kind: 'before-after', before: 'old', after: 'new' },
    ]);
  });

  it('does not pair indented code', () => {
    const body = PAIR.split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    expect(segmentMarkdownBody(body)).toEqual([{ kind: 'markdown', text: body }]);
  });
});

describe('hasCollapsibleContent', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
  const collapsible = (body: string) => hasCollapsibleContent(segmentMarkdownBody(body));

  it('counts a four-backtick fence as one block, the fences it quotes included', () => {
    expect(collapsible(['````md', ...lines(6), '```', ...lines(7), '````'].join('\n'))).toBe(true);
  });

  it('counts a long fence that never closes', () => {
    expect(collapsible(['```ts', ...lines(COLLAPSE_LINES + 1)].join('\n'))).toBe(true);
  });

  it('leaves out a long mermaid fence and a short one', () => {
    expect(collapsible(['```mermaid', ...lines(20), '```'].join('\n'))).toBe(false);
    expect(collapsible(['```', ...lines(COLLAPSE_LINES), '```'].join('\n'))).toBe(false);
  });
});
