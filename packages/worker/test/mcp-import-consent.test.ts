import { describe, expect, it } from 'vitest';
import { decideImportedMcpServers, sha256Hex } from '@haive/shared';
import {
  DEFAULT_MCP_SETTINGS_JSON,
  holdImportedMcpServers,
  mcpServersNeedingConsent,
} from '../src/sandbox/mcp-config.js';

const managed = (JSON.parse(DEFAULT_MCP_SETTINGS_JSON) as { mcpServers: Record<string, unknown> })
  .mcpServers;
const listWith = (extra: Record<string, unknown>) =>
  JSON.stringify({ mcpServers: { ...managed, ...extra } });
const evil = { command: 'sh', args: ['-c', 'echo reached'] };

describe('mcpServersNeedingConsent', () => {
  it('asks about nothing Haive ships itself', () => {
    expect(mcpServersNeedingConsent(DEFAULT_MCP_SETTINGS_JSON)).toEqual([]);
  });

  it('asks about every server beyond Haive own', () => {
    expect(mcpServersNeedingConsent(listWith({ zeta: evil, alpha: evil }))).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('asks about a different command under a name Haive manages', () => {
    const [name] = Object.keys(managed);
    expect(mcpServersNeedingConsent(listWith({ [name!]: evil }))).toEqual([name]);
  });

  it('reports an unreadable list as such', () => {
    expect(mcpServersNeedingConsent('{"mcpServers":')).toBeNull();
  });
});

describe('holdImportedMcpServers', () => {
  it('holds a list with servers nobody here accepted, keeping every other key', () => {
    const json = listWith({ evil });
    expect(holdImportedMcpServers({ ragMode: 'none', mcpSettingsJson: json })).toEqual({
      ragMode: 'none',
      importedMcpSettingsJson: json,
      importedMcpServerNames: ['evil'],
    });
  });

  it('leaves Haive own servers and unreadable lists where they are', () => {
    expect(holdImportedMcpServers({ mcpSettingsJson: DEFAULT_MCP_SETTINGS_JSON })).toBeNull();
    expect(holdImportedMcpServers({ mcpSettingsJson: '{' })).toBeNull();
    expect(holdImportedMcpServers({ ragMode: 'none' })).toBeNull();
  });

  it('holds a list other than the one accepted here', () => {
    const accepted = listWith({ evil });
    const changed = listWith({ evil, other: evil });
    expect(
      holdImportedMcpServers({
        mcpSettingsJson: changed,
        acceptedMcpSettingsSha256: sha256Hex(accepted),
      })?.importedMcpServerNames,
    ).toEqual(['evil', 'other']);
  });

  it('converges once the held list is accepted or discarded', () => {
    const tooling = holdImportedMcpServers({ mcpSettingsJson: listWith({ evil }) })!;
    const mirror = { schemaVersion: 1, tooling };
    const accepted = decideImportedMcpServers(mirror, 'accept')!;
    expect(accepted.tooling.mcpSettingsJson).toBe(listWith({ evil }));
    expect(holdImportedMcpServers(accepted.tooling)).toBeNull();
    expect(holdImportedMcpServers(decideImportedMcpServers(mirror, 'discard')!.tooling)).toBeNull();
  });
});
