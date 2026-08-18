import { describe, expect, it } from 'vitest';
import { isBelowDefaultEffort } from './effort-scale';

// Literal mirrors of the scales in @haive/shared's cli-providers/catalog.ts. Copied
// rather than imported because that module is only reachable through the shared
// barrel, which drags server-only deps into the web bundle. The authoritative
// drift guard for ollama's shape is packages/worker/test/effort-scale.test.ts,
// which asserts against the adapter itself.
const CLAUDE_CODE = { values: ['low', 'medium', 'high', 'xhigh', 'max'], max: 'max' };
const MUSE = { values: ['low', 'medium', 'high', 'xhigh'], max: 'xhigh' };
const CODEX = { values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], max: 'ultra' };
const OLLAMA = { values: ['low', 'medium', 'high', 'max'], max: 'high' };

describe('isBelowDefaultEffort', () => {
  it('reports a weaker level as below the default', () => {
    expect(isBelowDefaultEffort(CLAUDE_CODE.values, 'low', CLAUDE_CODE.max)).toBe(true);
    expect(isBelowDefaultEffort(CLAUDE_CODE.values, 'xhigh', CLAUDE_CODE.max)).toBe(true);
  });

  it('does not report the default itself', () => {
    expect(isBelowDefaultEffort(CLAUDE_CODE.values, 'max', CLAUDE_CODE.max)).toBe(false);
  });

  // The reason this helper exists. Ollama's default is `high` while `max` is still
  // selectable, so the old `chosen !== scale.max` test would have flagged the
  // STRONGER level as a downgrade and warned the user off it.
  it('does not report a level ABOVE the default on ollama', () => {
    expect(isBelowDefaultEffort(OLLAMA.values, 'max', OLLAMA.max)).toBe(false);
  });

  it('still reports genuinely weaker ollama levels', () => {
    expect(isBelowDefaultEffort(OLLAMA.values, 'low', OLLAMA.max)).toBe(true);
    expect(isBelowDefaultEffort(OLLAMA.values, 'medium', OLLAMA.max)).toBe(true);
    expect(isBelowDefaultEffort(OLLAMA.values, 'high', OLLAMA.max)).toBe(false);
  });

  // Every other adapter's default is the last element of values, so the ordinal
  // comparison reproduces the equality check it replaced, level for level.
  it.each([
    ['claude-code', CLAUDE_CODE],
    ['muse', MUSE],
    ['codex', CODEX],
  ])('matches the old equality behaviour for %s', (_name, scale) => {
    for (const level of scale.values) {
      expect(isBelowDefaultEffort(scale.values, level, scale.max)).toBe(level !== scale.max);
    }
  });

  // A stale DB row carrying a level the scale no longer lists is unorderable. It
  // must not masquerade as a downgrade and block onboarding with a warning about a
  // level that no longer exists.
  it('returns false when either level is absent from the scale', () => {
    expect(isBelowDefaultEffort(OLLAMA.values, 'xhigh', OLLAMA.max)).toBe(false);
    expect(isBelowDefaultEffort(OLLAMA.values, 'low', 'ultra')).toBe(false);
    expect(isBelowDefaultEffort([], 'low', 'high')).toBe(false);
  });
});
