import { describe, expect, it } from 'vitest';
import {
  parseSkillEntries,
  skillToMarkdown,
  type SkillEntry,
} from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';

describe('skillToMarkdown', () => {
  it('writes frontmatter and a minimal overview when only required fields present', () => {
    const entry: SkillEntry = {
      id: 'testing-skill',
      title: 'Testing skill',
      description: 'Covers how tests are structured.',
      overview: 'We use vitest for all unit tests.',
    };
    const md = skillToMarkdown(entry);
    expect(md).toMatch(
      /^---\nname: testing-skill\ndescription: Covers how tests are structured\.\n---/,
    );
    expect(md).toContain('# Testing skill');
    expect(md).toContain('## Overview');
    expect(md).toContain('We use vitest for all unit tests.');
    expect(md).not.toContain('## Quick Start');
    expect(md).not.toContain('## Key Concepts');
    expect(md).not.toContain('## Decision Tree');
  });

  it('falls back to description text when overview missing', () => {
    const entry: SkillEntry = {
      id: 'x',
      title: 'X',
      description: 'Fallback body here.',
    };
    const md = skillToMarkdown(entry);
    expect(md).toContain('## Overview');
    expect(md).toContain('Fallback body here.');
  });

  it('emits all structured sections when populated', () => {
    const entry: SkillEntry = {
      id: 'full',
      title: 'Full',
      description: 'Full description.',
      quickStart: '```\nnpm test\n```',
      overview: 'A full skill covering everything.',
      keyConcepts: [
        { term: 'Arrange', definition: 'Set up inputs' },
        { term: 'Act', definition: 'Invoke the function' },
      ],
      decisionTree: '```\nIs DB online?\n```',
      implementationPatterns: [{ name: 'Pattern A', body: 'Use this when...' }],
      pitfalls: [{ title: 'Pitfall X', body: 'Avoid foo' }],
      codeLocations: [{ label: 'Tests', path: 'packages/worker/test/' }],
      usage: 'Use freely.',
      instructions: 'Extra notes here.',
    };
    const md = skillToMarkdown(entry);
    expect(md).toContain('## Quick Start');
    expect(md).toContain('npm test');
    expect(md).toContain('## Key Concepts');
    expect(md).toContain('- **Arrange** — Set up inputs');
    expect(md).toContain('- **Act** — Invoke the function');
    expect(md).toContain('## Decision Tree');
    expect(md).toContain('Is DB online?');
    expect(md).toContain('## Implementation Patterns');
    expect(md).toContain('### Pattern A');
    expect(md).toContain('## Common Pitfalls');
    expect(md).toContain('### Pitfall X');
    expect(md).toContain('## Code Locations');
    expect(md).toContain('- **Tests** — `packages/worker/test/`');
    expect(md).toContain('## Additional Notes');
    expect(md).toContain('Extra notes here.');
    expect(md).toContain('## Usage');
    expect(md).toContain('Use freely.');
  });

  it('skips sections when their arrays are empty or entries invalid', () => {
    const entry: SkillEntry = {
      id: 'x',
      title: 'X',
      description: 'Desc.',
      overview: 'Body',
      keyConcepts: [],
      implementationPatterns: [{ name: '', body: '' } as unknown as { name: string; body: string }],
      pitfalls: [],
      codeLocations: [],
    };
    const md = skillToMarkdown(entry);
    expect(md).not.toContain('## Key Concepts');
    expect(md).not.toContain('## Common Pitfalls');
    expect(md).not.toContain('## Code Locations');
  });
});

describe('parseSkillEntries', () => {
  it('returns empty array for empty input', () => {
    expect(parseSkillEntries(null)).toEqual([]);
    expect(parseSkillEntries(undefined)).toEqual([]);
    expect(parseSkillEntries('')).toEqual([]);
  });

  it('parses a single JSON fenced skill from a string', () => {
    const raw =
      'some prose\n```json\n{"id":"a","title":"A","description":"d","overview":"ov"}\n```\n';
    const entries = parseSkillEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('a');
  });

  it('parses multiple JSON fenced skills', () => {
    const raw = [
      '```json',
      '{"id":"a","title":"A","description":"d","overview":"ov"}',
      '```',
      'intermission',
      '```json',
      '{"id":"b","title":"B","description":"d2","quickStart":"cmd"}',
      '```',
    ].join('\n');
    const entries = parseSkillEntries(raw);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('rejects skills with missing required fields or no body section', () => {
    const raw = [
      '```json',
      '{"id":"no-body","title":"X","description":"d"}',
      '```',
      '```json',
      '{"id":"","title":"X","description":"d","overview":"o"}',
      '```',
    ].join('\n');
    expect(parseSkillEntries(raw)).toEqual([]);
  });

  it('parses from an object with a skills array', () => {
    const raw = {
      skills: [{ id: 'a', title: 'A', description: 'd', overview: 'ov' }, { id: 'bad' }],
    };
    const entries = parseSkillEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('a');
  });

  it('parses directly from an array', () => {
    const raw = [
      { id: 'a', title: 'A', description: 'd', overview: 'ov' },
      { id: 'b', title: 'B', description: 'd', keyConcepts: [{ term: 't', definition: 'def' }] },
    ];
    const entries = parseSkillEntries(raw);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
