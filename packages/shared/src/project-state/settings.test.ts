import { describe, expect, it } from 'vitest';
import {
  PORTABLE_SETTING_NAMES,
  environmentUnitOf,
  portableSettingsOf,
  type PortableSettingColumns,
} from './settings.js';

const empty: PortableSettingColumns = {
  scopeExcludeGlobs: null,
  rtkEnabled: null,
  rtkVersion: null,
  lspServers: null,
  lspServerVersions: null,
  chromeDevtoolsMcpVersion: null,
  reviewDimensions: null,
};

describe('portableSettingsOf', () => {
  it('holds an entry per column that has a value, under its record name', () => {
    const settings = portableSettingsOf({
      scopeExcludeGlobs: ['vendor'],
      rtkEnabled: false,
      rtkVersion: '0.42.4',
      lspServers: ['vtsls'],
      lspServerVersions: { vtsls: '1.0.0', pyright: null },
      chromeDevtoolsMcpVersion: '0.9.0',
      reviewDimensions: ['security'],
    });

    expect(Object.keys(settings).sort()).toEqual([...PORTABLE_SETTING_NAMES].sort());
    expect(settings['rtk-enabled']).toBe(false);
    expect(settings['lsp-server-versions']).toEqual({ vtsls: '1.0.0', pyright: null });
  });

  it('leaves a column holding nothing out, so its file is not written', () => {
    expect(portableSettingsOf(empty)).toEqual({});
    expect(portableSettingsOf({ ...empty, scopeExcludeGlobs: undefined })).toEqual({});
  });

  it('keeps an empty list a value: never chosen and chosen empty are different', () => {
    expect(portableSettingsOf({ ...empty, scopeExcludeGlobs: [] })).toEqual({
      'scope-exclude-globs': [],
    });
  });

  it('takes nothing a reader could not, whatever a jsonb column holds', () => {
    expect(
      portableSettingsOf({
        ...empty,
        scopeExcludeGlobs: ['a', 1],
        lspServers: 'vtsls',
        lspServerVersions: { vtsls: 3 },
        rtkVersion: 4,
      }),
    ).toEqual({});
  });

  it('reads the named columns only: the app login and the verify commands never come along', () => {
    const row = {
      ...empty,
      scopeExcludeGlobs: ['vendor'],
      appAuth: { loginUrl: 'https://example.test/login' },
      verifyCommands: { test: 'run it' },
    };

    const settings = portableSettingsOf(row);

    expect(Object.keys(settings)).toEqual(['scope-exclude-globs']);
    expect(PORTABLE_SETTING_NAMES).not.toContain('app-auth');
    expect(PORTABLE_SETTING_NAMES).not.toContain('verify-commands');
    expect(PORTABLE_SETTING_NAMES).not.toContain('verify_commands');
  });
});

describe('environmentUnitOf', () => {
  const mirror = {
    schemaVersion: 1,
    envDetectData: { project: { name: 'acme' } },
    confirmedValues: { a: 1 },
  };

  it('is the mirror without its schema version', () => {
    expect(environmentUnitOf(mirror)).toEqual({
      envDetectData: mirror.envDetectData,
      confirmedValues: mirror.confirmedValues,
    });
  });

  it('is null for no column, another schema version or a malformed mirror', () => {
    expect(environmentUnitOf(null)).toBeNull();
    expect(environmentUnitOf(undefined)).toBeNull();
    expect(environmentUnitOf({ ...mirror, schemaVersion: 2 })).toBeNull();
    expect(environmentUnitOf({ ...mirror, confirmedValues: [] })).toBeNull();
    expect(environmentUnitOf({ schemaVersion: 1, envDetectData: {} })).toBeNull();
    expect(environmentUnitOf([])).toBeNull();
  });
});
