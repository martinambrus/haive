import { describe, it, expect } from 'vitest';
import {
  parseBrowserTestOutput,
  parseFixerOutput,
  parseChecklistOutput,
} from './08a-browser-verify.js';

describe('parseBrowserTestOutput', () => {
  it('parses a fenced tester verdict', () => {
    const raw =
      'tested\n```json\n{"passed":false,"failures":[{"description":"button invisible","evidence":"a.tsx:10"}],"visual_verdict":"UNSTYLED","notes":"x"}\n```';
    const p = parseBrowserTestOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.passed).toBe(false);
    expect(p!.failures).toHaveLength(1);
    expect(p!.failures[0]!.evidence).toBe('a.tsx:10');
    expect(p!.visualVerdict).toBe('UNSTYLED');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseBrowserTestOutput({
      passed: true,
      failures: [],
      visual_verdict: 'SKIPPED',
      notes: 'bypass stub',
    });
    expect(p).not.toBeNull();
    expect(p!.passed).toBe(true);
    expect(p!.visualVerdict).toBe('SKIPPED');
  });

  it('defaults failures/notes when omitted', () => {
    const p = parseBrowserTestOutput('```json\n{"passed":true}\n```');
    expect(p!.failures).toEqual([]);
    expect(p!.visualVerdict).toBeNull();
  });

  it('returns null on garbled output or a missing verdict (treated as fail by caller)', () => {
    expect(parseBrowserTestOutput('no json here')).toBeNull();
    expect(parseBrowserTestOutput('```json\n{"failures":[]}\n```')).toBeNull(); // no passed
    expect(parseBrowserTestOutput(null)).toBeNull();
  });
});

describe('parseFixerOutput', () => {
  it('parses a fenced fixer report', () => {
    const p = parseFixerOutput('```json\n{"fixes_made":["added aria-label"],"notes":"ok"}\n```');
    expect(p.fixesMade).toEqual(['added aria-label']);
    expect(p.notes).toBe('ok');
  });

  it('falls back to no-fixes on garbled output', () => {
    expect(parseFixerOutput('nope')).toEqual({ fixesMade: [], notes: '' });
  });
});

describe('parseChecklistOutput', () => {
  it('extracts checklist_markdown from fenced JSON', () => {
    const p = parseChecklistOutput(
      '```json\n{"checklist_markdown":"# Checklist\\n- [ ] step"}\n```',
    );
    expect(p).toContain('# Checklist');
    expect(p).toContain('- [ ] step');
  });

  it('falls back to raw markdown when not fenced JSON', () => {
    const md = '# Manual checklist\n- [ ] open the page';
    expect(parseChecklistOutput(md)).toBe(md);
  });
});
