import { describe, expect, it } from 'vitest';
import {
  cliAuthProviderVolumeName,
  cliAuthTaskVolumeName,
  cliAuthVolumeName,
  isCliAuthProviderVolume,
  isCliAuthTaskVolume,
  isCliAuthVolume,
} from '../src/cli-providers/auth-volume.js';

describe('cliAuthVolumeName (per-user shared)', () => {
  it('strips dashes and truncates user id to 12 chars', () => {
    expect(cliAuthVolumeName('aaaa-bbbb-cccc-dddd-eeeeffff', 'codex', 0)).toBe(
      'haive_cli_auth_aaaabbbbcccc_codex_0',
    );
  });

  it('encodes provider name and path index', () => {
    expect(cliAuthVolumeName('u1', 'gemini', 1)).toBe('haive_cli_auth_u1_gemini_1');
  });
});

describe('cliAuthProviderVolumeName (per-provider isolated)', () => {
  it('uses the _p_ segment so isolated volumes never collide with the per-user namespace', () => {
    const isolated = cliAuthProviderVolumeName('99b39acb-a6d1-440f-9c20-d1cb36cad964', 'gemini', 1);
    expect(isolated).toBe('haive_cli_auth_p_99b39acba6d1_gemini_1');
    expect(isolated).not.toEqual(cliAuthVolumeName('99b39acb-a6d1-440f', 'gemini', 1));
  });

  it('strips dashes from provider id and truncates to 12 chars', () => {
    expect(cliAuthProviderVolumeName('aaaa-bbbb-cccc-dddd', 'codex', 0)).toBe(
      'haive_cli_auth_p_aaaabbbbcccc_codex_0',
    );
  });

  it('two providers of the same CLI under the same user get distinct volume names', () => {
    const a = cliAuthProviderVolumeName('11111111-aaaa-bbbb', 'gemini', 0);
    const b = cliAuthProviderVolumeName('22222222-aaaa-bbbb', 'gemini', 0);
    expect(a).not.toBe(b);
  });
});

describe('isCliAuth* discriminators', () => {
  it('isCliAuthVolume matches every flavor (user / task / per-provider)', () => {
    expect(isCliAuthVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume('haive_repos')).toBe(false);
  });

  it('isCliAuthTaskVolume only matches the task namespace', () => {
    expect(isCliAuthTaskVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(true);
    expect(isCliAuthTaskVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(false);
    expect(isCliAuthTaskVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(false);
  });

  it('isCliAuthProviderVolume only matches the per-provider namespace', () => {
    expect(isCliAuthProviderVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(true);
    expect(isCliAuthProviderVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(false);
    expect(isCliAuthProviderVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(false);
  });
});
