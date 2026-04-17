import { describe, expect, it } from 'vitest';
import {
  kbIndexMarkdown,
  routeEntries,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

function entry(over: Record<string, unknown>) {
  return {
    id: 'x',
    title: 'X',
    sections: [{ heading: 'H', body: 'b' }],
    ...over,
  } as Parameters<typeof routeEntries>[0][number];
}

describe('routeEntries', () => {
  it('routes entries with a recognised canonical stem to UPPERCASE.md at KB root', () => {
    const out = routeEntries([entry({ id: 'arch', canonical: 'ARCHITECTURE' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.relPath).toBe('ARCHITECTURE.md');
    expect(out[0]!.bucket).toBe('core');
  });

  it('ignores unrecognised canonical values and falls back to topic routing', () => {
    const out = routeEntries([entry({ id: 'misc', canonical: 'NOT_A_REAL_CANONICAL_NAME' })]);
    expect(out[0]!.bucket).toBe('topic');
    expect(out[0]!.relPath).toBe('misc.md');
  });

  it('routes tech_pattern entries to TECH_PATTERNS/<tech>/INDEX.md', () => {
    const out = routeEntries([entry({ id: 'pty', category: 'tech_pattern', tech: 'node-pty' })]);
    expect(out[0]!.relPath).toBe('TECH_PATTERNS/node-pty/INDEX.md');
    expect(out[0]!.bucket).toBe('tech_pattern');
  });

  it('routes anti_pattern entries to ANTI_PATTERNS/<tech>-mistakes.md', () => {
    const out = routeEntries([
      entry({ id: 'shell-bad', category: 'anti_pattern', tech: 'Shell Scripts' }),
    ]);
    expect(out[0]!.relPath).toBe('ANTI_PATTERNS/shell-scripts-mistakes.md');
    expect(out[0]!.bucket).toBe('anti_pattern');
  });

  it('falls back to flat <id>.md when a tech_pattern entry forgets the tech field', () => {
    const out = routeEntries([entry({ id: 'unknown-tech', category: 'tech_pattern' })]);
    expect(out[0]!.relPath).toBe('unknown-tech.md');
    expect(out[0]!.bucket).toBe('topic');
  });

  it('dedupes by (bucket, key); first entry wins for duplicate canonical stems', () => {
    const out = routeEntries([
      entry({ id: 'first', canonical: 'ARCHITECTURE', title: 'first' }),
      entry({ id: 'second', canonical: 'ARCHITECTURE', title: 'second' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry.title).toBe('first');
  });

  it('dedupes tech_pattern entries that target the same tech', () => {
    const out = routeEntries([
      entry({ id: 'a', category: 'tech_pattern', tech: 'node-pty' }),
      entry({ id: 'b', category: 'tech_pattern', tech: 'node-pty' }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('kbIndexMarkdown', () => {
  it('renders Core / Tech Patterns / Anti-Patterns / Topics sections from routed buckets', () => {
    const routed = routeEntries([
      entry({ id: 'arch', title: 'Architecture', canonical: 'ARCHITECTURE' }),
      entry({ id: 'pty', title: 'node-pty Patterns', category: 'tech_pattern', tech: 'node-pty' }),
      entry({
        id: 'pty-bad',
        title: 'node-pty Pitfalls',
        category: 'anti_pattern',
        tech: 'node-pty',
      }),
      entry({ id: 'misc', title: 'Misc Topic' }),
    ]);
    const md = kbIndexMarkdown(routed, 'sample-project');
    expect(md).toMatch(/^# Knowledge Base Index/);
    expect(md).toContain('sample-project');
    expect(md).toContain('## Core Files');
    expect(md).toContain('- ARCHITECTURE.md - Architecture');
    expect(md).toContain('## Tech Patterns');
    expect(md).toContain('- TECH_PATTERNS/node-pty/INDEX.md - node-pty Patterns');
    expect(md).toContain('## Anti-Patterns');
    expect(md).toContain('- ANTI_PATTERNS/node-pty-mistakes.md - node-pty Pitfalls');
    expect(md).toContain('## Topics');
    expect(md).toContain('- misc.md - Misc Topic');
  });

  it('omits sections that have no routed entries', () => {
    const routed = routeEntries([entry({ id: 'arch', canonical: 'ARCHITECTURE' })]);
    const md = kbIndexMarkdown(routed, null);
    expect(md).toContain('## Core Files');
    expect(md).not.toContain('## Tech Patterns');
    expect(md).not.toContain('## Anti-Patterns');
    expect(md).not.toContain('## Topics');
  });
});
