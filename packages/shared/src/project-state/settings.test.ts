import { describe, expect, it } from 'vitest';
import {
  PORTABLE_SETTING_NAMES,
  environmentColumnOf,
  environmentUnitOf,
  intakeSettings,
  normalizeEnvironment,
  normalizeSetting,
  portableSettingsOf,
  settingColumnUpdate,
  withoutUnchosenRtk,
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

describe('normalizeSetting', () => {
  const ok = (name: string, value: unknown) => normalizeSetting(name, value);

  it('keeps the scope list as the exclusions route stores it: trimmed, unique, without managed dirs, sorted', () => {
    expect(ok('scope-exclude-globs', ['/vendor/', 'b', '', 'a', 'b'])).toEqual({
      ok: true,
      value: ['a', 'b', 'vendor'],
    });
    expect(ok('scope-exclude-globs', ['.haive-data', 'x'])).toEqual({ ok: true, value: ['x'] });
    expect(ok('scope-exclude-globs', 'vendor')).toEqual({ ok: false });
  });

  it('keeps the LSP lists as the tooling route stores them', () => {
    expect(ok('lsp-servers', ['vtsls', 'made-up', 'vtsls'])).toEqual({
      ok: true,
      value: ['vtsls'],
    });
    expect(ok('lsp-server-versions', { vtsls: ' 1.0 ', pyright: '', x: '1', gopls: null })).toEqual(
      {
        ok: true,
        value: { vtsls: '1.0' },
      },
    );
    expect(ok('lsp-server-versions', [])).toEqual({ ok: false });
  });

  it('keeps review dimensions known and canonical, and refuses none', () => {
    expect(ok('review-dimensions', ['security', 'nope'])).toEqual({
      ok: true,
      value: ['security'],
    });
    expect(ok('review-dimensions', ['nope'])).toEqual({ ok: false });
    expect(ok('review-dimensions', [])).toEqual({ ok: false });
  });

  it('takes a boolean for RTK and a non-empty string for a version, and no other name', () => {
    expect(ok('rtk-enabled', false)).toEqual({ ok: true, value: false });
    expect(ok('rtk-enabled', 'false')).toEqual({ ok: false });
    expect(ok('rtk-version', ' 0.42.4 ')).toEqual({ ok: true, value: '0.42.4' });
    expect(ok('chrome-devtools-mcp-version', '')).toEqual({ ok: false });
    expect(ok('app-auth', {})).toEqual({ ok: false });
  });
});

describe('settingColumnUpdate', () => {
  it('names the column and the stored value', () => {
    expect(settingColumnUpdate('review-dimensions', ['security'])).toEqual({
      reviewDimensions: ['security'],
    });
    expect(settingColumnUpdate('rtk-enabled', false)).toEqual({ rtkEnabled: false });
  });

  it('unsets a column that can be unset, and writes nothing for one that cannot', () => {
    expect(settingColumnUpdate('rtk-version', undefined)).toEqual({ rtkVersion: null });
    expect(settingColumnUpdate('rtk-enabled', undefined)).toBeNull();
    expect(settingColumnUpdate('scope-exclude-globs', undefined)).toBeNull();
  });

  it('writes nothing for an unknown name or a value no column holds', () => {
    expect(settingColumnUpdate('app-auth', { loginUrl: 'x' })).toBeNull();
    expect(settingColumnUpdate('lsp-servers', 'vtsls')).toBeNull();
  });
});

describe('intakeSettings', () => {
  it('passes a valid setting normalised, and a rejected one as this install holds it', () => {
    const intake = intakeSettings(
      { 'review-dimensions': ['nope'], 'rtk-version': '1', 'lsp-servers': ['vtsls', 'x'] },
      { 'review-dimensions': ['security'] },
    );
    expect(intake.incoming).toEqual({
      'review-dimensions': ['security'],
      'rtk-version': '1',
      'lsp-servers': ['vtsls'],
    });
    expect(intake.accepted).toEqual({ 'rtk-version': '1', 'lsp-servers': ['vtsls'] });
    expect(intake.rejected).toEqual(['review-dimensions']);
  });

  it('holds RTK and the scope list as this install has them where the checkout has none', () => {
    const intake = intakeSettings(
      {},
      { 'rtk-enabled': true, 'scope-exclude-globs': ['a'], 'rtk-version': '1' },
    );
    expect(intake.incoming).toEqual({ 'rtk-enabled': true, 'scope-exclude-globs': ['a'] });
    expect(intake.rejected).toEqual([]);
  });

  it('ignores a name that is not portable', () => {
    expect(intakeSettings({ 'app-auth': {}, 'from-the-future': 1 }, {}).incoming).toEqual({});
  });
});

describe('the environment', () => {
  it('drops the prompt-only fields and carries the schema version into the column', () => {
    const env = normalizeEnvironment({
      envDetectData: { project: 1, __digest: 'x' },
      confirmedValues: { a: 1 },
    });
    expect(env).toEqual({ envDetectData: { project: 1 }, confirmedValues: { a: 1 } });
    expect(environmentColumnOf(env)).toEqual({ schemaVersion: 1, ...env });
    expect(environmentUnitOf(environmentColumnOf(env))).toEqual(env);
  });
});

describe('withoutUnchosenRtk', () => {
  const settings = { 'rtk-enabled': true, 'rtk-version': '1' };

  it('drops the RTK switch while the choice is not recorded, and nothing else', () => {
    expect({ ...withoutUnchosenRtk(settings, false) }).toEqual({ 'rtk-version': '1' });
  });

  it('keeps it once recorded, and never changes its input', () => {
    expect({ ...withoutUnchosenRtk(settings, true) }).toEqual(settings);
    withoutUnchosenRtk(settings, false);
    expect(settings['rtk-enabled']).toBe(true);
  });
});
