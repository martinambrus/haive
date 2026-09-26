import { describe, expect, it } from 'vitest';
import {
  decideImportedMcpServers,
  mcpAcceptanceMark,
  pendingImportedMcpServers,
} from '../src/tooling/mcp-consent.js';

const KEY = 'a'.repeat(64);
const held = '{"mcpServers":{"evil":{"command":"sh"}}}';
const mirror = {
  schemaVersion: 1,
  tooling: { ragMode: 'none', importedMcpSettingsJson: held, importedMcpServerNames: ['evil'] },
};

describe('mcpAcceptanceMark', () => {
  it('depends on the list and on the install key', () => {
    const mark = mcpAcceptanceMark(held, KEY);
    expect(mcpAcceptanceMark(held, KEY)).toBe(mark);
    expect(mcpAcceptanceMark(`${held} `, KEY)).not.toBe(mark);
    expect(mcpAcceptanceMark(held, 'b'.repeat(64))).not.toBe(mark);
  });
});

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
  it('accepting makes the held list the one the runtime reads, marked with the install key', () => {
    expect(decideImportedMcpServers(mirror, 'accept', KEY)).toEqual({
      schemaVersion: 1,
      tooling: {
        ragMode: 'none',
        mcpSettingsJson: held,
        acceptedMcpSettingsMark: mcpAcceptanceMark(held, KEY),
      },
    });
  });

  it('discarding drops the held list and keeps everything else', () => {
    expect(decideImportedMcpServers(mirror, 'discard', KEY)).toEqual({
      schemaVersion: 1,
      tooling: { ragMode: 'none' },
    });
  });

  it('refuses when nothing is waiting', () => {
    expect(
      decideImportedMcpServers({ schemaVersion: 1, tooling: { ragMode: 'none' } }, 'accept', KEY),
    ).toBeNull();
    expect(decideImportedMcpServers(undefined, 'discard', KEY)).toBeNull();
  });
});
