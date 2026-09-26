import { describe, expect, it } from 'vitest';
import { decideImportedMcpServers, pendingImportedMcpServers } from '../src/tooling/mcp-consent.js';
import { sha256Hex } from '../src/templates/manifest.js';

const held = '{"mcpServers":{"evil":{"command":"sh"}}}';
const mirror = {
  schemaVersion: 1,
  tooling: { ragMode: 'none', importedMcpSettingsJson: held, importedMcpServerNames: ['evil'] },
};

describe('pendingImportedMcpServers', () => {
  it('names the held servers', () => {
    expect(pendingImportedMcpServers(mirror)).toEqual(['evil']);
  });

  it('is null when nothing is held', () => {
    expect(
      pendingImportedMcpServers({ schemaVersion: 1, tooling: { ragMode: 'none' } }),
    ).toBeNull();
    expect(pendingImportedMcpServers(null)).toBeNull();
    expect(pendingImportedMcpServers({ schemaVersion: 1, tooling: ['x'] })).toBeNull();
  });

  it('still reports a held list whose names were not recorded', () => {
    expect(
      pendingImportedMcpServers({ schemaVersion: 1, tooling: { importedMcpSettingsJson: held } }),
    ).toEqual([]);
  });
});

describe('decideImportedMcpServers', () => {
  it('accepting makes the held list the one the runtime reads, and records which list it was', () => {
    expect(decideImportedMcpServers(mirror, 'accept')).toEqual({
      schemaVersion: 1,
      tooling: {
        ragMode: 'none',
        mcpSettingsJson: held,
        acceptedMcpSettingsSha256: sha256Hex(held),
      },
    });
  });

  it('discarding drops the held list and keeps everything else', () => {
    expect(decideImportedMcpServers(mirror, 'discard')).toEqual({
      schemaVersion: 1,
      tooling: { ragMode: 'none' },
    });
  });

  it('refuses when nothing is waiting', () => {
    expect(
      decideImportedMcpServers({ schemaVersion: 1, tooling: { ragMode: 'none' } }, 'accept'),
    ).toBeNull();
    expect(decideImportedMcpServers(undefined, 'discard')).toBeNull();
  });
});
