import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
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
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
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

  it('keeps a secret-looking key that never made it into secrets', async () => {
    const { fake, db } = setup();
    addProvider(fake, P1, LEGACY);
    await dropCopiedSecretLikeProviderEnv(db);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual(LEGACY);
  });
});
