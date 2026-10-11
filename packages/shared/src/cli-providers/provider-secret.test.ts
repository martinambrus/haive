import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { Database } from '@haive/database';
import { computeKeyFingerprint, envelopeDecrypt } from '../crypto/index.js';
import { upsertProviderSecret } from './provider-secret.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const KEK = 'ab'.repeat(32);

function setup() {
  const fake = createFakeDb({ cliProviderSecrets: schema.cliProviderSecrets });
  return { fake, db: fake.db as unknown as Database };
}

function stored(fake: ReturnType<typeof setup>['fake']) {
  return fake.rows(schema.cliProviderSecrets).map((r) => ({
    name: r.secretName as string,
    fingerprint: r.fingerprint as string,
    value: envelopeDecrypt(
      { encryptedValue: r.encryptedValue as string, encryptedDek: r.encryptedDek as string },
      KEK,
    ),
  }));
}

const input = (value: string, onExisting: 'overwrite' | 'keep') => ({
  providerId: PROVIDER,
  name: 'API_KEY',
  value,
  masterKek: KEK,
  onExisting,
});

describe('upsertProviderSecret', () => {
  it('inserts an encrypted secret with its fingerprint and returns the row', async () => {
    const { fake, db } = setup();
    const row = await upsertProviderSecret(db, input('first-value', 'overwrite'));
    expect(stored(fake)).toEqual([
      { name: 'API_KEY', fingerprint: computeKeyFingerprint('first-value'), value: 'first-value' },
    ]);
    expect(row).toMatchObject({
      secretName: 'API_KEY',
      fingerprint: computeKeyFingerprint('first-value'),
    });
  });

  it('overwrite replaces the value and the fingerprint of an existing secret', async () => {
    const { fake, db } = setup();
    await upsertProviderSecret(db, input('first-value', 'overwrite'));
    await upsertProviderSecret(db, input('second-value', 'overwrite'));
    expect(stored(fake)).toEqual([
      {
        name: 'API_KEY',
        fingerprint: computeKeyFingerprint('second-value'),
        value: 'second-value',
      },
    ]);
  });

  it('keep leaves an existing secret as it was', async () => {
    const { fake, db } = setup();
    await upsertProviderSecret(db, input('first-value', 'overwrite'));
    const row = await upsertProviderSecret(db, input('second-value', 'keep'));
    expect(stored(fake)).toEqual([
      { name: 'API_KEY', fingerprint: computeKeyFingerprint('first-value'), value: 'first-value' },
    ]);
    expect(row.fingerprint).toBe(computeKeyFingerprint('first-value'));
  });

  it('keep inserts when nothing exists', async () => {
    const { fake, db } = setup();
    await upsertProviderSecret(db, input('first-value', 'keep'));
    expect(stored(fake)).toHaveLength(1);
  });
});
