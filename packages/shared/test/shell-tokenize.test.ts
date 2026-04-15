import { describe, it, expect } from 'vitest';
import { tokenizeShellArgs, normalizeCliArgsArray } from '../src/utils/shell-tokenize.js';

describe('tokenizeShellArgs', () => {
  it('returns empty for empty input', () => {
    expect(tokenizeShellArgs('')).toEqual([]);
    expect(tokenizeShellArgs('   ')).toEqual([]);
  });

  it('splits bare tokens on whitespace', () => {
    expect(tokenizeShellArgs('--flag value')).toEqual(['--flag', 'value']);
    expect(tokenizeShellArgs('a b\tc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps double-quoted segments together and strips outer quotes', () => {
    expect(tokenizeShellArgs('--param "value with spaces"')).toEqual([
      '--param',
      'value with spaces',
    ]);
  });

  it('keeps single-quoted segments together', () => {
    expect(tokenizeShellArgs("--param 'a b c'")).toEqual(['--param', 'a b c']);
  });

  it('unwraps a lone quoted value', () => {
    expect(tokenizeShellArgs('"/caveman"')).toEqual(['/caveman']);
    expect(tokenizeShellArgs("'/caveman'")).toEqual(['/caveman']);
  });

  it('handles mixed --key=value styles', () => {
    expect(tokenizeShellArgs('--mcp-config ".claude/mcp.json"')).toEqual([
      '--mcp-config',
      '.claude/mcp.json',
    ]);
  });

  it('honors backslash escapes inside double quotes', () => {
    expect(tokenizeShellArgs('"with \\"inner\\" quotes"')).toEqual(['with "inner" quotes']);
  });

  it('does not interpret escapes inside single quotes', () => {
    expect(tokenizeShellArgs("'raw \\n string'")).toEqual(['raw \\n string']);
  });

  it('concatenates adjacent quoted and bare spans', () => {
    expect(tokenizeShellArgs('pre"mid"post')).toEqual(['premidpost']);
  });

  it('is idempotent for already-clean input', () => {
    const clean = ['--flag', 'value'];
    expect(clean.flatMap((t) => tokenizeShellArgs(t))).toEqual(['--flag', 'value']);
  });
});

describe('normalizeCliArgsArray', () => {
  it('flattens multi-token entries', () => {
    expect(
      normalizeCliArgsArray([
        '"/caveman"',
        '--dangerously-skip-permissions',
        '--mcp-config ".claude/mcp_settings.json"',
      ]),
    ).toEqual([
      '/caveman',
      '--dangerously-skip-permissions',
      '--mcp-config',
      '.claude/mcp_settings.json',
    ]);
  });

  it('drops empty entries', () => {
    expect(normalizeCliArgsArray(['', '  ', '--flag'])).toEqual(['--flag']);
  });
});
