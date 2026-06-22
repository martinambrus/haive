import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from './_fenced-json.js';

describe('parseJsonLoose', () => {
  it('parses a clean ```json fenced block', () => {
    expect(parseJsonLoose('```json\n{"a": 1, "b": [2, 3]}\n```')).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses fence-less raw JSON', () => {
    expect(parseJsonLoose('{"x": true}')).toEqual({ x: true });
  });

  it('parses a top-level array', () => {
    expect(parseJsonLoose('```json\n[1, 2, 3]\n```')).toEqual([1, 2, 3]);
  });

  it('ignores prose before and after the fenced JSON', () => {
    const text =
      'Now I have enough information. Here is the result:\n```json\n{"agentQuestions": [], "explicitNoQuestions": true}\n```\nDone.';
    expect(parseJsonLoose(text)).toEqual({ agentQuestions: [], explicitNoQuestions: true });
  });

  it('handles nested ``` fences inside a string value (balanced scan, not greedy/lazy regex)', () => {
    const text =
      '```json\n{"content": "Example:\\n```js\\nconst x = 1;\\n```\\nend", "ok": true}\n```';
    expect(parseJsonLoose(text)).toEqual({
      content: 'Example:\n```js\nconst x = 1;\n```\nend',
      ok: true,
    });
  });

  it('salvages a trailing comma via jsonrepair', () => {
    expect(parseJsonLoose('```json\n{"a": 1, "b": 2,}\n```')).toEqual({ a: 1, b: 2 });
  });

  it('salvages a truncated stream (no closing brace, no closing fence)', () => {
    const parsed = parseJsonLoose(
      '```json\n{"agentQuestions": [{"id": "x", "topic": "t"',
    ) as Record<string, unknown> | null;
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed?.agentQuestions)).toBe(true);
  });

  // The exact 98-char output that failed step 09-qa in production (model narrated its
  // intent then ended the turn with no JSON). Must return null so the retry path fires.
  it('returns null for the real narration-only failure', () => {
    expect(
      parseJsonLoose(
        'Let me check the TODO file to understand what aspects of the system might be ambiguous or unclear.',
      ),
    ).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseJsonLoose('')).toBeNull();
  });
});
