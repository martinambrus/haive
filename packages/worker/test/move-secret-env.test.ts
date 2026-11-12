const authLock = vi.hoisted(() => ({
  acquire: vi.fn(),
  error: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: authLock.acquire,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => ({ error: authLock.error }) },
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { createFakeDb } from '@haive/database/testing';
import { envelopeDecrypt, envelopeEncrypt, secretsService } from '@haive/shared';
import {
  copySecretLikeProviderEnv,
  dropCopiedSecretLikeProviderEnv,
} from '../src/secrets/move-secret-env.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const KEK = 'ab'.repeat(32);
const TOKEN = 'oauth-token-value';

function setup() {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  return { fake, db: fake.db as unknown as Database };
}

function addProvider(fake: ReturnType<typeof setup>['fake'], id: string, envVars: unknown) {
  fake.insert(schema.cliProviders, {
    id,
    userId: USER,
    name: 'claude-code',
    label: id,
    envVars,
  });
}

function secrets(fake: ReturnType<typeof setup>['fake'], providerId: string) {
  return Object.fromEntries(
    fake
      .rows(schema.cliProviderSecrets)
      .filter((r) => r.providerId === providerId)
      .map((r) => [
        r.secretName as string,
        envelopeDecrypt(
          { encryptedValue: r.encryptedValue as string, encryptedDek: r.encryptedDek as string },
          KEK,
        ),
      ]),
  );
}

beforeEach(() => {
  authLock.acquire.mockReset().mockResolvedValue(authLock.release);
  authLock.release.mockClear();
  authLock.release.assertHeld.mockReset().mockResolvedValue(undefined);
  authLock.error.mockClear();
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
});

afterEach(() => {
  vi.useRealTimers();
});

const LEGACY = { ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_OAUTH_TOKEN: TOKEN };

describe('copySecretLikeProviderEnv (boot)', () => {
  it('copies a legacy secret into secrets and leaves envVars for a rollback', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    addProvider(fake, P2, null);
    await copySecretLikeProviderEnv(db);
    expect(fake.rows(schema.cliProviders).find((r) => r.id === P1)!.envVars).toEqual(LEGACY);
    expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(fake.rows(schema.cliProviders).find((r) => r.id === P2)!.envVars).toBeNull();
  });

  it('is a no-op on a second run', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    await copySecretLikeProviderEnv(db);
    const before = JSON.stringify([
      fake.rows(schema.cliProviders),
      fake.rows(schema.cliProviderSecrets),
    ]);
    await copySecretLikeProviderEnv(db);
    expect(
      JSON.stringify([fake.rows(schema.cliProviders), fake.rows(schema.cliProviderSecrets)]),
    ).toBe(before);
  });

  it('keeps an existing secret of the same name', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, { CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-copy' });
    fake.insert(schema.cliProviderSecrets, {
      providerId: P1,
      secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
      ...envelopeEncrypt(TOKEN, KEK),
      fingerprint: 'fp',
    });
    await copySecretLikeProviderEnv(db);
    expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  });

  it('never loads the master key when no provider needs a copy', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, { ANTHROPIC_BASE_URL: 'u' });
    const kek = vi.spyOn(secretsService, 'getMasterKek');
    kek.mockClear();
    await copySecretLikeProviderEnv(db);
    expect(kek).not.toHaveBeenCalled();
  });
});

describe('dropCopiedSecretLikeProviderEnv (committed upgrade)', () => {
  it('drops the envVars copy once a secret holds it, keeping config keys', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    await copySecretLikeProviderEnv(db);
    await dropCopiedSecretLikeProviderEnv(db);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({ ANTHROPIC_BASE_URL: 'u' });
    expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('copies a key the boot half never copied before dropping it', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    await dropCopiedSecretLikeProviderEnv(db);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({ ANTHROPIC_BASE_URL: 'u' });
    expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('finishes the others, then fails, when one provider cannot be scrubbed', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    addProvider(fake, P2, LEGACY);
    await copySecretLikeProviderEnv(db);
    const real = db.transaction.bind(db);
    let calls = 0;
    vi.spyOn(db, 'transaction').mockImplementation(((run: never) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('connection lost')) : real(run);
    }) as typeof db.transaction);
    await expect(dropCopiedSecretLikeProviderEnv(db)).rejects.toThrow('1 provider(s)');
    const envs = fake.rows(schema.cliProviders).map((r) => r.envVars);
    expect(envs).toContainEqual(LEGACY);
    expect(envs).toContainEqual({ ANTHROPIC_BASE_URL: 'u' });
  });
});

it.each(
  ['copy', 'drop'].flatMap((phase) => [false, true].map((isolateAuth) => ({ phase, isolateAuth }))),
)(
  'fences the legacy $phase writer with isolateAuth=$isolateAuth and stamps only a new credential',
  async ({ phase, isolateAuth }) => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    fake.patch(schema.cliProviders, P1, { isolateAuth });
    const run = phase === 'copy' ? copySecretLikeProviderEnv : dropCopiedSecretLikeProviderEnv;
    const before = fake.rows(schema.cliProviders)[0]!.authGeneration;
    await run(db);
    expect(fake.rows(schema.cliProviders)[0]!.authGeneration).not.toBe(before);
    expect(authLock.acquire).toHaveBeenCalledOnce();
    expect(authLock.acquire).toHaveBeenCalledWith(
      db,
      cliAuthScope(fake.rows(schema.cliProviders)[0] as never),
    );
    expect(authLock.release).toHaveBeenCalledOnce();
    const after = fake.rows(schema.cliProviders)[0]!.authGeneration;
    await run(db);
    expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(after);
  },
);
it('defers a busy boot copy after one lock attempt without waiting', async () => {
  vi.useFakeTimers();
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  const before = fake.rows(schema.cliProviders);
  authLock.acquire.mockResolvedValueOnce(null);
  const transaction = vi.spyOn(db, 'transaction');
  let settled = false;
  const result = copySecretLikeProviderEnv(db).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  await result;
  expect(authLock.acquire).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(transaction).not.toHaveBeenCalled();
  expect(authLock.error).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: P1, phase: 'copy' }),
    'provider env secret migration failed',
  );
  expect(authLock.release).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(fake.rows(schema.cliProviders)).toEqual(before);
});

it.each(
  ['copy', 'drop'].flatMap((phase) =>
    [
      { authMode: 'api_key' },
      { isolateAuth: true },
      { userId: '10000000-0000-4000-8000-0000000000a2' },
      { name: 'codex' },
    ].map((change) => ({ phase, change })),
  ),
)('defers legacy $phase when its locked scope changed: $change', async ({ phase, change }) => {
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  const scope = cliAuthScope(fake.rows(schema.cliProviders)[0] as never);
  authLock.acquire.mockImplementationOnce(async () => {
    fake.patch(schema.cliProviders, P1, change);
    return authLock.release;
  });
  const before = fake.rows(schema.cliProviders)[0]!.authGeneration;
  if (phase === 'copy') await copySecretLikeProviderEnv(db);
  else await expect(dropCopiedSecretLikeProviderEnv(db)).rejects.toThrow('1 provider(s)');
  expect(authLock.acquire).toHaveBeenCalledExactlyOnceWith(db, scope);
  expect(cliAuthScope(fake.rows(schema.cliProviders)[0] as never)).not.toBe(scope);
  expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
  expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
    ...change,
    envVars: LEGACY,
    authGeneration: before,
  });
  expect(authLock.error).toHaveBeenCalledWith(
    {
      err: expect.objectContaining({
        message: 'CLI authentication settings changed; provider secret migration was deferred',
      }),
      providerId: P1,
      phase,
    },
    'provider env secret migration failed',
  );
  expect(authLock.release).toHaveBeenCalledOnce();

  // The next boot copy / committed-upgrade retry takes the new scope and converges.
  const retry = phase === 'copy' ? copySecretLikeProviderEnv : dropCopiedSecretLikeProviderEnv;
  await retry(db);
  expect(authLock.acquire).toHaveBeenLastCalledWith(
    db,
    cliAuthScope(fake.rows(schema.cliProviders)[0] as never),
  );
  expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual(
    phase === 'copy' ? LEGACY : { ANTHROPIC_BASE_URL: 'u' },
  );
});

it.each(['copy', 'drop'])(
  'defers legacy %s if the locked row newly needs auth fencing',
  async (phase) => {
    const { fake, db } = setup();
    addProvider(fake, P1, { SERVICE_TOKEN: 'service-token' });
    const real = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((run) => {
      fake.patch(schema.cliProviders, P1, { envVars: LEGACY });
      return real(run);
    });
    const before = fake.rows(schema.cliProviders)[0]!.authGeneration;
    if (phase === 'copy') await copySecretLikeProviderEnv(db);
    else await expect(dropCopiedSecretLikeProviderEnv(db)).rejects.toThrow('1 provider(s)');
    expect(authLock.acquire).not.toHaveBeenCalled();
    expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      envVars: LEGACY,
      authGeneration: before,
    });
    expect(authLock.error).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: P1, phase }),
      'provider env secret migration failed',
    );
  },
);

it.each(['copy', 'drop'])(
  'allows legacy %s when settings change within the same auth scope',
  async (phase) => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    fake.patch(schema.cliProviders, P1, { isolateAuth: true });
    const scope = cliAuthScope(fake.rows(schema.cliProviders)[0] as never);
    authLock.acquire.mockImplementationOnce(async () => {
      fake.patch(schema.cliProviders, P1, { authMode: 'api_key' });
      return authLock.release;
    });
    await (phase === 'copy' ? copySecretLikeProviderEnv : dropCopiedSecretLikeProviderEnv)(db);
    expect(cliAuthScope(fake.rows(schema.cliProviders)[0] as never)).toBe(scope);
    expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(authLock.error).not.toHaveBeenCalled();
  },
);

it.each(['copy', 'drop'])(
  'skips legacy %s work when the locked row no longer has secrets',
  async (phase) => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    authLock.acquire.mockImplementationOnce(async () => {
      fake.patch(schema.cliProviders, P1, { envVars: { ANTHROPIC_BASE_URL: 'u' } });
      return authLock.release;
    });
    const kek = vi.spyOn(secretsService, 'getMasterKek');
    kek.mockClear();
    await (phase === 'copy' ? copySecretLikeProviderEnv : dropCopiedSecretLikeProviderEnv)(db);
    expect(kek).not.toHaveBeenCalled();
    expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
    expect(authLock.error).not.toHaveBeenCalled();
    expect(authLock.release).toHaveBeenCalledOnce();
  },
);

it('waits for busy authentication to become available before dropping legacy env', async () => {
  vi.useFakeTimers();
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  authLock.acquire.mockResolvedValueOnce(null);
  const transaction = vi.spyOn(db, 'transaction');
  const result = dropCopiedSecretLikeProviderEnv(db);
  await vi.advanceTimersByTimeAsync(499);
  expect(authLock.acquire).toHaveBeenCalledOnce();
  expect(transaction).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(authLock.acquire).toHaveBeenCalledTimes(2);
  expect(secrets(fake, P1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({ ANTHROPIC_BASE_URL: 'u' });
  expect(authLock.release).toHaveBeenCalledOnce();
});

it('refuses a destructive drop when authentication stays busy past the deadline', async () => {
  vi.useFakeTimers();
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  authLock.acquire.mockResolvedValue(null);
  const transaction = vi.spyOn(db, 'transaction');
  let settled = false;
  const result = dropCopiedSecretLikeProviderEnv(db).catch((err: unknown) => {
    settled = true;
    return err;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  expect(authLock.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual(new Error('1 provider(s) still hold a secret in plain envVars'));
  expect(authLock.error).toHaveBeenCalledWith(
    {
      err: expect.objectContaining({
        message: 'CLI authentication is busy; provider secret migration was deferred',
      }),
      providerId: P1,
      phase: 'drop',
    },
    'provider env secret migration failed',
  );
  expect(transaction).not.toHaveBeenCalled();
  expect(authLock.release).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual(LEGACY);
});

it('rolls back a copied legacy credential and its generation together', async () => {
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  const before = fake.rows(schema.cliProviders);
  fake.hooks.beforeCommit = async () => {
    throw new Error('commit refused');
  };
  await copySecretLikeProviderEnv(db);
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(fake.rows(schema.cliProviders)).toEqual(before);
  expect(authLock.release).toHaveBeenCalledOnce();
});

it.each(['copy', 'drop'])('rolls back legacy %s on lock loss before commit', async (phase) => {
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  const before = fake.rows(schema.cliProviders);
  fake.hooks.beforeInsert = async () => {
    authLock.release.assertHeld.mockRejectedValue(new Error('lock lost'));
  };
  if (phase === 'copy') await copySecretLikeProviderEnv(db);
  else await expect(dropCopiedSecretLikeProviderEnv(db)).rejects.toThrow('1 provider(s)');
  expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
  expect(fake.rows(schema.cliProviders)).toEqual(before);
  expect(authLock.release).toHaveBeenCalledOnce();
});

it.each(['copy', 'drop'])('refuses legacy %s when key loading loses the lock', async (phase) => {
  const { fake, db } = setup();
  addProvider(fake, P1, LEGACY);
  vi.spyOn(secretsService, 'getMasterKek').mockImplementationOnce(async () => {
    authLock.release.assertHeld.mockRejectedValue(new Error('lock lost'));
    return KEK;
  });
  if (phase === 'copy') await copySecretLikeProviderEnv(db);
  else await expect(dropCopiedSecretLikeProviderEnv(db)).rejects.toThrow('1 provider(s)');
  expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
  expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual(LEGACY);
});
