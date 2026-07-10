import { describe, it, expect } from 'vitest';
import { parseJsonLoose, parseJsonLooseValidated } from './_fenced-json.js';

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

  it('salvages an unescaped inner double-quote left by a weak model', () => {
    // A literal `"` inside a value, left unescaped, desyncs the balanced scanner
    // AND jsonrepair (both read it as a string boundary); the inner-quote escape
    // tier recovers it. This is the deepseek `... and `"` to `&quot;` ...` failure.
    const text = '{"note": "press the " key to continue", "ok": true}';
    expect(parseJsonLoose(text)).toEqual({ note: 'press the " key to continue', ok: true });
  });

  it('parses valid JSON with properly escaped inner quotes (no false re-escape)', () => {
    expect(parseJsonLoose('{"a": "say \\"hi\\" ok", "b": 1}')).toEqual({
      a: 'say "hi" ok',
      b: 1,
    });
  });

  it('returns null for an empty string', () => {
    expect(parseJsonLoose('')).toBeNull();
  });
});

describe('parseJsonLooseValidated', () => {
  // Accept only objects that name a verdict — the reviewer-shape gate in miniature.
  const wantVerdict = (c: unknown): { verdict: unknown } | null =>
    typeof c === 'object' && c !== null && 'verdict' in c ? (c as { verdict: unknown }) : null;

  it('skips an evidence fence and returns the agent’s own JSON', () => {
    // parseJsonLoose alone anchors on the FIRST fence and would return the evidence.
    const text = [
      'The change pins an outdated core:',
      '```json',
      '{"require": {"drupal/core": "^10.0.0"}}',
      '```',
      'Verdict:',
      '```json',
      '{"verdict": "REQUEST_CHANGES"}',
      '```',
    ].join('\n');
    expect(parseJsonLoose(text)).toEqual({ require: { 'drupal/core': '^10.0.0' } });
    expect(parseJsonLooseValidated(text, wantVerdict)).toEqual({ verdict: 'REQUEST_CHANGES' });
  });

  it('takes the LAST accepted candidate — the agent finishes with its answer', () => {
    const text = '{"verdict": "APPROVE"}\nlater:\n{"verdict": "DISCUSS"}';
    expect(parseJsonLooseValidated(text, wantVerdict)).toEqual({ verdict: 'DISCUSS' });
  });

  it('does not let an inline example in narration outrank the fenced answer', () => {
    // First-accepted-wins would report APPROVE here: a silent approval, entered through
    // a different door than the evidence fence above.
    const text = [
      'I will not simply emit {"verdict": "APPROVE"} without checking.',
      '```json',
      '{"verdict": "REQUEST_CHANGES"}',
      '```',
    ].join('\n');
    expect(parseJsonLooseValidated(text, wantVerdict)).toEqual({ verdict: 'REQUEST_CHANGES' });
  });

  it('ignores a brace that is only prose', () => {
    // `src/{a,b}.ts` is not a candidate (no quoted key), so the real JSON is found.
    // parseJsonLoose balance-scans that brace and gives up.
    const text = 'Checked src/{a,b}.ts.\n\n{"verdict": "APPROVE"}';
    expect(parseJsonLoose(text)).toBeNull();
    expect(parseJsonLooseValidated(text, wantVerdict)).toEqual({ verdict: 'APPROVE' });
  });

  it('falls back to the deep salvage when no scanned candidate is accepted', () => {
    // Single quotes: no `{"` to scan, so only jsonrepair (via parseJsonLoose) recovers it.
    expect(parseJsonLooseValidated("```json\n{'verdict': 'APPROVE'}\n```", wantVerdict)).toEqual({
      verdict: 'APPROVE',
    });
    // Truncated: no balanced close, so again only the fallback tier reaches it.
    const truncated = '```json\n{"verdict": "DISCUSS", "findings": [{"issue": "x"';
    expect(parseJsonLooseValidated(truncated, wantVerdict)).not.toBeNull();
  });

  it('returns null when every candidate is rejected', () => {
    expect(parseJsonLooseValidated('```json\n{"require": {"a": 1}}\n```', wantVerdict)).toBeNull();
    expect(parseJsonLooseValidated('no json at all', wantVerdict)).toBeNull();
  });
});
