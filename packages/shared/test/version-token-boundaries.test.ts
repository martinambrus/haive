import { describe, expect, it } from 'vitest';
import {
  intakeSettings,
  normalizeSetting,
  settingColumnUpdate,
} from '../src/project-state/settings.js';
import {
  createCliProviderRequestSchema,
  updateCliProviderRequestSchema,
} from '../src/schemas/cli-providers.js';
const HOSTILE = [
  '1.2.3\nRUN id',
  '$(id)',
  '`id`',
  '1.2.3;id',
  '"1.2.3"',
  "'1.2.3'",
  '-latest',
  '1 2',
  '1\0x',
  '１.2.3',
  '1.2.3\n',
  ' 1.2.3',
  '1.2.3\u2028',
  'a'.repeat(65),
];
const VALID = ['1.2.3', 'v1.0.1', '1.18.4', 'latest', '2.0.0-rc.1', '1.0.0+build.5'];
describe('portable version boundaries', () => {
  for (const name of ['rtk-version', 'lsp-server-versions', 'chrome-devtools-mcp-version']) {
    it.each(HOSTILE)(`${name} refuses %j and keeps local state`, (token) => {
      const value =
        name === 'lsp-server-versions'
          ? { 'intelephense-extended': '1.18.4', pyright: token }
          : token;
      const local = name === 'lsp-server-versions' ? { pyright: '1.2.3' } : '1.2.3';
      expect(normalizeSetting(name, value)).toMatchObject({
        ok: false,
        reason: expect.any(String),
      });
      expect(settingColumnUpdate(name, value)).toBeNull();
      const intake = intakeSettings({ [name]: value }, { [name]: local });
      expect(intake.rejected).toEqual([name]);
      expect(intake.accepted).not.toHaveProperty(name);
      expect(intake.incoming[name]).toEqual(local);
    });
  }
  it.each(VALID)('keeps valid version %s unchanged', (token) => {
    expect(normalizeSetting('rtk-version', token)).toEqual({ ok: true, value: token });
    expect(normalizeSetting('lsp-server-versions', { 'intelephense-extended': token })).toEqual({
      ok: true,
      value: { 'intelephense-extended': token },
    });
    expect(normalizeSetting('chrome-devtools-mcp-version', token)).toEqual({
      ok: true,
      value: token,
    });
  });
  it.each(HOSTILE)('refuses CLI provider input %j on create and update', (cliVersion) => {
    expect(
      createCliProviderRequestSchema.safeParse({
        name: 'codex',
        label: 'Codex',
        authMode: 'subscription',
        cliVersion,
      }).success,
    ).toBe(false);
    expect(updateCliProviderRequestSchema.safeParse({ cliVersion }).success).toBe(false);
  });
});
