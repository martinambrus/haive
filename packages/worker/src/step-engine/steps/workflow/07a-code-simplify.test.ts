import { describe, it, expect } from 'vitest';
import { parseSimplifierOutput, parseFixupOutput } from './07a-code-simplify.js';

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
