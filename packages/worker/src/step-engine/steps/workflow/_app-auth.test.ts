import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { StepContext } from '../../step-definition.js';

const m = vi.hoisted(() => ({ get: vi.fn(), getMany: vi.fn(), runnerExec: vi.fn() }));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  userSecretsService: { get: m.get, getMany: m.getMany },
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  runnerExec: m.runnerExec,
}));

import {
  appAuthPromptLines,
  appAuthSecretNames,
  isUsableAppAuth,
  loginAppBrowser,
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

describe('loginAppBrowser reads the credential pair', () => {
  const names = appAuthSecretNames('repo-1');
  const store = new Map<string, string>();
  // Generated: a literal username and password pair reads as a leaked credential to secret scanners.
  const username = `user-${randomUUID()}`;
  const password = `pass-${randomUUID()}`;
  const ctx = {
    userId: 'user-1',
    taskId: 'task-1',
    db: {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: 'repo-1' }) },
        repositories: { findFirst: async () => ({ appAuth: VALID }) },
      },
    },
  } as unknown as StepContext;
  const runtime = { mode: 'ddev' as const, handle: {} as never };

  beforeEach(() => {
    store.clear();
    m.get
      .mockReset()
      .mockImplementation(async (_userId: string, key: string) => store.get(key) ?? null);
    m.getMany
      .mockReset()
      .mockImplementation(
        async (_userId: string, keys: string[]) =>
          new Map<string, string | null>(keys.map((k) => [k, store.get(k) ?? null])),
      );
    m.runnerExec.mockReset().mockResolvedValue({ exitCode: 0, output: '{"ok":true,"reason":""}' });
  });

  it('with one getMany call naming both keys, never two gets, and logs in with that pair', async () => {
    store.set(names.username, username).set(names.password, password);
    expect(await loginAppBrowser(ctx, runtime)).toEqual({ attempted: true, ok: true, reason: '' });
    expect(m.getMany).toHaveBeenCalledTimes(1);
    expect(m.getMany).toHaveBeenCalledWith('user-1', [names.username, names.password]);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.runnerExec).toHaveBeenCalledWith(
      runtime.handle,
      expect.any(String),
      expect.objectContaining({
        env: { HAIVE_APP_USERNAME: username, HAIVE_APP_PASSWORD: password },
      }),
    );
  });

  it.each<[string, string[]]>([
    ['the password is missing', [names.username]],
    ['the username is missing', [names.password]],
    ['both are missing', []],
  ])('and answers "credentials are missing" when %s', async (_case, stored) => {
    for (const key of stored) store.set(key, 'stored');
    expect(await loginAppBrowser(ctx, runtime)).toEqual({
      attempted: false,
      ok: false,
      reason: 'app login is configured but its credentials are missing from the secret store',
    });
    expect(m.getMany).toHaveBeenCalledTimes(1);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.runnerExec).not.toHaveBeenCalled();
  });
});
