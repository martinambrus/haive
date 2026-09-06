import { describe, it, expect } from 'vitest';
import {
  parseSimplifierOutput,
  parseFixupOutput,
  parallelAuthorshipLines,
} from './07a-code-simplify.js';

describe('parseSimplifierOutput', () => {
  it('parses a fenced JSON simplifier report', () => {
    const raw =
      'reviewed\n```json\n{"files_simplified":["a.ts","b.ts"],"changes_made":["flattened nesting"],"no_changes_needed":false}\n```';
    const p = parseSimplifierOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.filesSimplified).toEqual(['a.ts', 'b.ts']);
    expect(p!.changesMade).toEqual(['flattened nesting']);
    expect(p!.noChangesNeeded).toBe(false);
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseSimplifierOutput({
      files_simplified: [],
      changes_made: [],
      no_changes_needed: true,
    });
    expect(p).not.toBeNull();
    expect(p!.noChangesNeeded).toBe(true);
    expect(p!.filesSimplified).toEqual([]);
  });

  it('derives no_changes_needed from an empty file list when omitted', () => {
    const p = parseSimplifierOutput('```json\n{"files_simplified":[],"changes_made":[]}\n```');
    expect(p!.noChangesNeeded).toBe(true);
    const q = parseSimplifierOutput(
      '```json\n{"files_simplified":["x.ts"],"changes_made":["y"]}\n```',
    );
    expect(q!.noChangesNeeded).toBe(false);
  });

  it('returns null on garbled or empty output', () => {
    expect(parseSimplifierOutput('no json here')).toBeNull();
    expect(parseSimplifierOutput('```json\n{broken}\n```')).toBeNull();
    expect(parseSimplifierOutput(null)).toBeNull();
    expect(parseSimplifierOutput(undefined)).toBeNull();
  });
});

describe('parseFixupOutput', () => {
  it('parses a fenced fixup report', () => {
    const p = parseFixupOutput(
      '```json\n{"fixes_needed":true,"fixes_made":["restored null check"]}\n```',
    );
    expect(p.fixesNeeded).toBe(true);
    expect(p.fixesMade).toEqual(['restored null check']);
  });

  it('falls back to no-fixes on garbled output', () => {
    expect(parseFixupOutput('not json')).toEqual({ fixesNeeded: false, fixesMade: [] });
    expect(parseFixupOutput(null)).toEqual({ fixesNeeded: false, fixesMade: [] });
  });

  it('applies defaults for omitted fields', () => {
    const p = parseFixupOutput({ fixes_needed: false });
    expect(p.fixesMade).toEqual([]);
  });
});

describe('parallelAuthorshipLines', () => {
  it('names the coder and level counts for a DAG task', () => {
    const lines = parallelAuthorshipLines({ issues: 7, levels: 3 });
    expect(lines.join('\n')).toContain('7 agents across 3 dependency levels');
    expect(lines.join('\n')).toContain('isolated worktree');
  });

  it('says nothing for single-agent work, or a detect payload written before the field', () => {
    expect(parallelAuthorshipLines(null)).toEqual([]);
    expect(parallelAuthorshipLines(undefined)).toEqual([]);
  });

  it('says nothing for a one-issue DAG — there is no cross-issue boundary', () => {
    expect(parallelAuthorshipLines({ issues: 1, levels: 1 })).toEqual([]);
  });
});
