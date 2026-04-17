import { describe, expect, it } from 'vitest';
import {
  sanitizeSubSkills,
  type SkillEntry,
  type SkillSubSkill,
  skillsReadmeMarkdown,
  skillToMarkdown,
  subSkillToMarkdown,
} from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';

const goodSub: SkillSubSkill = {
  slug: 'attribution',
  name: 'task-tracking-attribution',
  title: 'Attribution',
  description: 'Per-task attribution using recomputeForDateRange.',
  category: 'Attribution and Output',
  summary: 'recomputeForDateRange per window',
  body: '## Purpose\n\nWindows get scored.\n\n## Code\n\n- `lib/stats.mjs`',
};

describe('sanitizeSubSkills', () => {
  it('returns [] when no subSkills present', () => {
    const entry: SkillEntry = { id: 'x', title: 'X', description: 'd', overview: 'o' };
    expect(sanitizeSubSkills(entry)).toEqual([]);
  });

  it('drops sub-skills missing required fields', () => {
    const entry: SkillEntry = {
      id: 'x',
      title: 'X',
      description: 'd',
      subSkills: [
        goodSub,
        { ...goodSub, slug: 'no-summary', summary: '' as unknown as string },
        { ...goodSub, slug: 'no-body', body: '' as unknown as string },
      ],
    };
    const out = sanitizeSubSkills(entry);
    expect(out.map((s) => s.slug)).toEqual(['attribution']);
  });

  it('normalises slugs to kebab-case and dedupes after normalisation', () => {
    const entry: SkillEntry = {
      id: 'x',
      title: 'X',
      description: 'd',
      subSkills: [
        { ...goodSub, slug: 'Foo Bar', name: 'a' },
        { ...goodSub, slug: 'foo--bar', name: 'b' },
        { ...goodSub, slug: 'baz', name: 'c' },
      ],
    };
    const out = sanitizeSubSkills(entry);
    expect(out.map((s) => s.slug)).toEqual(['foo-bar', 'baz']);
  });
});

describe('subSkillToMarkdown', () => {
  it('emits frontmatter with the full name + description, plus an Identification block linking back to parent', () => {
    const md = subSkillToMarkdown('task-tracking', goodSub);
    expect(md).toContain('name: task-tracking-attribution');
    expect(md).toContain('description: Per-task attribution using recomputeForDateRange.');
    expect(md).toContain('# Attribution');
    expect(md).toContain('## Identification');
    expect(md).toContain('- **Parent**: [task-tracking/SKILL.md](../SKILL.md)');
    expect(md).toContain('## Purpose');
  });

  it('appends extra identification rows above the Parent row when provided', () => {
    const md = subSkillToMarkdown('task-tracking', {
      ...goodSub,
      identification: [{ label: 'Function', value: 'lib/stats.mjs::recomputeForDateRange' }],
    });
    expect(md).toContain('- **Function**: lib/stats.mjs::recomputeForDateRange');
    expect(md.indexOf('Function')).toBeLessThan(md.indexOf('Parent'));
  });

  it('uses YAML folded form when description is long or multi-line', () => {
    const longDesc =
      'Long activation description that runs well past the single-line threshold ' +
      'so the renderer should switch to the YAML folded scalar form for readability.';
    const md = subSkillToMarkdown('task-tracking', { ...goodSub, description: longDesc });
    expect(md).toContain('description: >');
  });
});

describe('skillToMarkdown with sub-skills', () => {
  const entry: SkillEntry = {
    id: 'task-tracking',
    title: 'Task Tracking',
    description: 'Domain skill.',
    overview: 'Overview body.',
    subSkills: [
      { ...goodSub, slug: 'attribution', summary: 'attribution summary' },
      {
        ...goodSub,
        slug: 'commit-windows',
        name: 'task-tracking-commit-windows',
        title: 'Commit Windows',
        description: 'd',
        category: 'Window Construction',
        summary: 'merge-vs-standalone windowing',
      },
      {
        ...goodSub,
        slug: 'parallel-groups',
        name: 'task-tracking-parallel-groups',
        title: 'Parallel Groups',
        description: 'd',
        category: 'Window Construction',
        summary: 'overlap detection',
      },
    ],
    relatedSkills: [{ path: '../statistics/SKILL.md', summary: 'shares helper' }],
    quickReference: '| Concept | Value |\n|---------|-------|\n| Gap | 15 min |',
  };

  it('renders Sub-Skills section grouped by category, with relative links', () => {
    const md = skillToMarkdown(entry);
    expect(md).toContain('## Sub-Skills');
    expect(md).toContain('### Attribution and Output');
    expect(md).toContain('### Window Construction');
    expect(md).toContain(
      '- [sub-skills/attribution.md](./sub-skills/attribution.md) - attribution summary',
    );
    expect(md).toContain(
      '- [sub-skills/commit-windows.md](./sub-skills/commit-windows.md) - merge-vs-standalone windowing',
    );
  });

  it('auto-generates a Decision Tree from sub-skills when none provided', () => {
    const md = skillToMarkdown(entry);
    expect(md).toContain('## Decision Tree');
    expect(md).toContain('|-- Attribution? -> See sub-skills/attribution.md');
    expect(md).toContain('|-- Commit Windows? -> See sub-skills/commit-windows.md');
  });

  it('preserves an explicit Decision Tree when provided and skips auto-generation', () => {
    const md = skillToMarkdown({ ...entry, decisionTree: '```\nCustom tree\n```' });
    expect(md).toContain('Custom tree');
    expect(md).not.toContain('|-- Attribution? -> See');
  });

  it('renders Quick Reference and Related Skills blocks when provided', () => {
    const md = skillToMarkdown(entry);
    expect(md).toContain('## Quick Reference');
    expect(md).toContain('| Gap | 15 min |');
    expect(md).toContain('## Related Skills');
    expect(md).toContain('- [../statistics/SKILL.md](../statistics/SKILL.md) - shares helper');
  });
});

describe('skillsReadmeMarkdown', () => {
  it('renders index header, table, and directory layout block', () => {
    const md = skillsReadmeMarkdown([
      { id: 'task-tracking', title: 'Task Tracking', description: 'Per-task attribution.' },
      { id: 'pty-wrapping', title: 'PTY Wrapping', description: 'PTY spawn + I/O.' },
    ]);
    expect(md).toMatch(/^# Skills Index/);
    expect(md).toContain('## Skill Architecture');
    expect(md).toContain('| Skill | Summary |');
    expect(md).toContain('| [pty-wrapping](./pty-wrapping/SKILL.md) | PTY spawn + I/O. |');
    expect(md).toContain('| [task-tracking](./task-tracking/SKILL.md) | Per-task attribution. |');
    expect(md).toContain('## Directory Layout');
    expect(md).toContain('SKILL.md');
    expect(md).toContain('sub-skills/');
  });

  it('sorts skills alphabetically by id', () => {
    const md = skillsReadmeMarkdown([
      { id: 'zeta', title: 'Z', description: 'z' },
      { id: 'alpha', title: 'A', description: 'a' },
    ]);
    expect(md.indexOf('alpha')).toBeLessThan(md.indexOf('zeta'));
  });
});
