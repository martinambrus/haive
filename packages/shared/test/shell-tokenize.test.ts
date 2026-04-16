import { describe, it, expect } from 'vitest';
import { normalizeCliArgsArray } from '../src/utils/shell-tokenize.js';

describe('normalizeCliArgsArray', () => {
  it('returns empty for empty / whitespace-only input', () => {
    expect(normalizeCliArgsArray([])).toEqual([]);
    expect(normalizeCliArgsArray(['', '  ', '\t'])).toEqual([]);
  });

  it('keeps a bare token as one argument', () => {
    expect(normalizeCliArgsArray(['/caveman'])).toEqual(['/caveman']);
  });

  it('keeps a bare flag as one argument', () => {
    expect(normalizeCliArgsArray(['--dangerously-skip-permissions'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('splits a flag-value line at the first whitespace', () => {
    expect(normalizeCliArgsArray(['--mcp-config ".claude/mcp_settings.json"'])).toEqual([
      '--mcp-config',
      '.claude/mcp_settings.json',
    ]);
  });

  it('strips a single pair of outer matching quotes on the tail', () => {
    expect(normalizeCliArgsArray(["-n '42'"])).toEqual(['-n', '42']);
    expect(normalizeCliArgsArray(['-n "42"'])).toEqual(['-n', '42']);
  });

  it('preserves embedded quotes inside the tail verbatim', () => {
    expect(
      normalizeCliArgsArray([
        '--append-system-prompt \'ones that look "simple", "practical", "obvious", or "straightforward"\'',
      ]),
    ).toEqual([
      '--append-system-prompt',
      'ones that look "simple", "practical", "obvious", or "straightforward"',
    ]);
  });

  it('preserves long prose values verbatim', () => {
    const longProse =
      'CRITICALLY IMPORTANT: Never start a response with the conclusion. This applies to ALL questions — including ones that look "simple", "practical", "obvious", or "straightforward".';
    expect(normalizeCliArgsArray([`--append-system-prompt '${longProse}'`])).toEqual([
      '--append-system-prompt',
      longProse,
    ]);
  });

  it('strips outer matching quotes from a standalone quoted line', () => {
    expect(normalizeCliArgsArray(['"/caveman"'])).toEqual(['/caveman']);
    expect(normalizeCliArgsArray(["'/caveman'"])).toEqual(['/caveman']);
  });

  it('keeps --flag=value style on a single line', () => {
    expect(normalizeCliArgsArray(['--model=opus-4'])).toEqual(['--model=opus-4']);
  });

  it('treats positional arguments with spaces (non-flag lines) as one verbatim arg', () => {
    expect(normalizeCliArgsArray(['value with spaces'])).toEqual(['value with spaces']);
  });

  it('handles a flag whose value itself starts with a dash', () => {
    expect(normalizeCliArgsArray(['--exec --help'])).toEqual(['--exec', '--help']);
  });

  it('drops empty entries and processes each line independently', () => {
    expect(
      normalizeCliArgsArray([
        '/caveman',
        '',
        '--dangerously-skip-permissions',
        '  ',
        '--mcp-config .claude/mcp.json',
      ]),
    ).toEqual(['/caveman', '--dangerously-skip-permissions', '--mcp-config', '.claude/mcp.json']);
  });

  it("handles the user's 4-line Claude Code input end-to-end", () => {
    const longProse =
      'CRITICALLY IMPORTANT: Never start a response with the conclusion. Every response must begin with at least one paragraph laying out the constraints and considerations before stating any answer or recommendation. This applies to ALL questions — including ones that look "simple", "practical", "obvious", or "straightforward". Labeling a question as not needing analysis is itself a failure mode — the analysis IS the answer, even when the conclusion is short. Do not treat these instructions as rules to be worked around when the question feels easy; the question feeling easy is exactly when you are most likely to be wrong.';
    const input = [
      '/caveman',
      '--dangerously-skip-permissions',
      '--mcp-config ".claude/mcp_settings.json"',
      `--append-system-prompt '${longProse}'`,
    ];
    expect(normalizeCliArgsArray(input)).toEqual([
      '/caveman',
      '--dangerously-skip-permissions',
      '--mcp-config',
      '.claude/mcp_settings.json',
      '--append-system-prompt',
      longProse,
    ]);
  });
});
