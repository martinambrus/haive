import { describe, expect, it } from 'vitest';
import { mcpSettingsFileContent } from '../src/sandbox/mcp-config.js';

describe('mcpSettingsFileContent', () => {
  it('returns the empty-stub config when the textarea is empty', () => {
    expect(mcpSettingsFileContent('')).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it('returns the empty-stub config when the textarea is whitespace-only', () => {
    expect(mcpSettingsFileContent('   \n\t\n')).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it('emits a parseable empty-MCP JSON payload for the empty case', () => {
    const parsed = JSON.parse(mcpSettingsFileContent(''));
    expect(parsed).toEqual({ mcpServers: {} });
  });

  it('preserves non-empty input verbatim and appends a trailing newline', () => {
    const input =
      '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": [] }\n  }\n}';
    expect(mcpSettingsFileContent(input)).toBe(input + '\n');
  });

  it('does not double-append a newline when the input already ends with one', () => {
    const input = '{\n  "mcpServers": {}\n}\n';
    expect(mcpSettingsFileContent(input)).toBe(input);
  });
});
