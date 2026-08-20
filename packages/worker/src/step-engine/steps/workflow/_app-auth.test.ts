import { describe, it, expect } from 'vitest';
import {
  appAuthPromptLines,
  appAuthSecretNames,
  isUsableAppAuth,
  parseLoginOutput,
} from './_app-auth.js';

const VALID = {
  enabled: true,
  loginUrl: 'https://app.ddev.site/login',
  usernameSelector: '#email',
  passwordSelector: '#password',
  submitSelector: 'button[type="submit"]',
  successCondition: { type: 'url_contains' as const, value: '/dashboard' },
};

describe('isUsableAppAuth', () => {
  it('accepts a fully specified config', () => {
    expect(isUsableAppAuth(VALID)).toBe(true);
  });

  it('rejects a config that is disabled', () => {
    expect(isUsableAppAuth({ ...VALID, enabled: false })).toBe(false);
  });

  it('rejects a half-filled config rather than letting it fail at a selector', () => {
    // A partial config would make browser-login.js time out on a missing selector, which
    // reads as "the login is broken" — a different thing from "no login is configured",
    // and the user needs to be told the right one.
    for (const key of [
      'loginUrl',
      'usernameSelector',
      'passwordSelector',
      'submitSelector',
    ] as const) {
      expect(isUsableAppAuth({ ...VALID, [key]: '' }), key).toBe(false);
      const without = { ...VALID } as Record<string, unknown>;
      delete without[key];
      expect(isUsableAppAuth(without), `missing ${key}`).toBe(false);
    }
  });

  it('requires a success condition it knows how to check', () => {
    expect(isUsableAppAuth({ ...VALID, successCondition: undefined })).toBe(false);
    expect(isUsableAppAuth({ ...VALID, successCondition: { type: 'vibes', value: 'ok' } })).toBe(
      false,
    );
    expect(
      isUsableAppAuth({ ...VALID, successCondition: { type: 'url_contains', value: '' } }),
    ).toBe(false);
    expect(
      isUsableAppAuth({
        ...VALID,
        successCondition: { type: 'element_present', value: '.avatar' },
      }),
    ).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isUsableAppAuth(null)).toBe(false);
    expect(isUsableAppAuth('yes')).toBe(false);
  });
});

describe('parseLoginOutput', () => {
  it('reads the result line out of surrounding runner noise', () => {
    const out = ['some bash -lc banner', '{"ok":true,"reason":"","url":"/dashboard"}', ''].join(
      '\n',
    );
    expect(parseLoginOutput(out)).toEqual({ ok: true, reason: '' });
  });

  it('carries the reason back on a refused login', () => {
    expect(parseLoginOutput('{"ok":false,"reason":"url / does not contain /dashboard"}')).toEqual({
      ok: false,
      reason: 'url / does not contain /dashboard',
    });
  });

  it('treats unreadable output as a failed login, never a successful one', () => {
    // The one direction that must not slip: reporting an unverified login as success
    // would put the tester on an app it is not actually authenticated to.
    expect(parseLoginOutput('').ok).toBe(false);
    expect(parseLoginOutput('node: command not found').ok).toBe(false);
    expect(parseLoginOutput('{"ok":').ok).toBe(false);
  });
});

describe('appAuthPromptLines', () => {
  it('tells an authenticated tester not to log in or out', () => {
    const lines = appAuthPromptLines({ attempted: true, ok: true, reason: '' }).join('\n');
    expect(lines).toContain('AUTHENTICATED SESSION');
    expect(lines).toContain('do NOT log out');
  });

  it('tells an unauthenticated tester to report a login wall as a coverage limit', () => {
    // Otherwise it files "the app redirects to /login" as a defect in the change.
    const lines = appAuthPromptLines({ attempted: false, ok: false, reason: '' }).join('\n');
    expect(lines).toContain('UNAUTHENTICATED SESSION');
    expect(lines).toContain('LIMIT ON YOUR COVERAGE');
  });

  it('says unauthenticated when a login was attempted and failed', () => {
    const lines = appAuthPromptLines({ attempted: true, ok: false, reason: 'bad password' }).join(
      '\n',
    );
    expect(lines).toContain('UNAUTHENTICATED SESSION');
  });
});

describe('appAuthSecretNames', () => {
  it('scopes the credentials per repository, not per user', () => {
    // One user commonly onboards several apps; a per-user key would collide.
    expect(appAuthSecretNames('repo-1')).toEqual({
      username: 'app_auth:repo-1:username',
      password: 'app_auth:repo-1:password',
    });
    expect(appAuthSecretNames('repo-2').password).not.toBe(appAuthSecretNames('repo-1').password);
  });
});
