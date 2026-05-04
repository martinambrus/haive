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

  it('routes best_practice entries to BEST_PRACTICES/<tech>-best-practices.md', () => {
    const out = routeEntries([
      entry({ id: 'gradle-bp', category: 'best_practice', tech: 'gradle' }),
    ]);
    expect(out[0]!.relPath).toBe('BEST_PRACTICES/gradle-best-practices.md');
    expect(out[0]!.bucket).toBe('best_practice');
    expect(out[0]!.key).toBe('gradle');
  });

  it('routes quick_reference entries to QUICK_REFERENCE/<tech>/cheat-sheet.md', () => {
    const out = routeEntries([
      entry({ id: 'lwjgl2-cs', category: 'quick_reference', tech: 'lwjgl2' }),
    ]);
    expect(out[0]!.relPath).toBe('QUICK_REFERENCE/lwjgl2/cheat-sheet.md');
    expect(out[0]!.bucket).toBe('quick_reference');
    expect(out[0]!.key).toBe('lwjgl2');
  });

  it('falls back to flat <id>.md when best_practice/quick_reference miss the tech field', () => {
    const out = routeEntries([
      entry({ id: 'orphan-bp', category: 'best_practice' }),
      entry({ id: 'orphan-qr', category: 'quick_reference' }),
    ]);
    expect(out[0]!.bucket).toBe('topic');
    expect(out[0]!.relPath).toBe('orphan-bp.md');
    expect(out[1]!.bucket).toBe('topic');
    expect(out[1]!.relPath).toBe('orphan-qr.md');
  });

  it('dedupes best_practice and quick_reference entries by tech', () => {
    const out = routeEntries([
      entry({ id: 'a', category: 'best_practice', tech: 'gradle' }),
      entry({ id: 'b', category: 'best_practice', tech: 'gradle' }),
      entry({ id: 'c', category: 'quick_reference', tech: 'gradle' }),
      entry({ id: 'd', category: 'quick_reference', tech: 'gradle' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.bucket).sort()).toEqual(['best_practice', 'quick_reference']);
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
    expect(md).not.toContain('## Best Practices');
    expect(md).not.toContain('## Quick References');
    expect(md).not.toContain('## Topics');
  });

  it('renders Best Practices and Quick References sections when present', () => {
    const routed = routeEntries([
      entry({
        id: 'gradle-bp',
        title: 'Gradle Best Practices',
        category: 'best_practice',
        tech: 'gradle',
      }),
      entry({
        id: 'gradle-cs',
        title: 'Gradle Cheat Sheet',
        category: 'quick_reference',
        tech: 'gradle',
      }),
    ]);
    const md = kbIndexMarkdown(routed, null);
    expect(md).toContain('## Best Practices');
    expect(md).toContain('- BEST_PRACTICES/gradle-best-practices.md - Gradle Best Practices');
    expect(md).toContain('## Quick References');
    expect(md).toContain('- QUICK_REFERENCE/gradle/cheat-sheet.md - Gradle Cheat Sheet');
  });

  it('renders all six bucket sections in order: core / tech / best / anti / quick / topic', () => {
    const routed = routeEntries([
      entry({ id: 'misc', title: 'Misc' }),
      entry({ id: 'gradle-cs', title: 'Cheat', category: 'quick_reference', tech: 'gradle' }),
      entry({ id: 'gradle-bad', title: 'Bad', category: 'anti_pattern', tech: 'gradle' }),
      entry({ id: 'gradle-bp', title: 'Best', category: 'best_practice', tech: 'gradle' }),
      entry({ id: 'gradle-tp', title: 'Pattern', category: 'tech_pattern', tech: 'gradle' }),
      entry({ id: 'arch', title: 'Architecture', canonical: 'ARCHITECTURE' }),
    ]);
    const md = kbIndexMarkdown(routed, null);
    const order = [
      md.indexOf('## Core Files'),
      md.indexOf('## Tech Patterns'),
      md.indexOf('## Best Practices'),
      md.indexOf('## Anti-Patterns'),
      md.indexOf('## Quick References'),
      md.indexOf('## Topics'),
    ];
    // Each header must appear and be in strictly increasing order.
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }
  });
});
