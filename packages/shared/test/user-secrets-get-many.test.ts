import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { generateEncryptionKey } from '../src/crypto/index.js';

const h = vi.hoisted(() => ({ logger: { info: vi.fn(), error: vi.fn() } }));

vi.mock('../src/logger/index.js', () => ({ logger: h.logger }));

import { UserSecretsService } from '../src/config/user-secrets.service.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const USERNAME = 'app_auth:repo-1:username';
const PASSWORD = 'app_auth:repo-1:password';

async function setup() {
  const fake = createFakeDb({ userSecrets: schema.userSecrets });
  const service = new UserSecretsService();
  await service.initialize(fake.db as unknown as Database, generateEncryptionKey());
  await service.set(USER, USERNAME, 'alice');
  await service.set(USER, PASSWORD, 'hunter2-password');
  await service.set(OTHER, USERNAME, 'mallory');
  const reads = [
    vi.spyOn(fake.db.query.userSecrets, 'findFirst'),
    vi.spyOn(fake.db.query.userSecrets, 'findMany'),
    vi.spyOn(fake.db, 'select'),
  ];
  const statements = () => reads.reduce((n, read) => n + read.mock.calls.length, 0);
  return { fake, service, statements };
}

describe('UserSecretsService.getMany', () => {
  it('returns every named secret, decrypted', async () => {
    const { service } = await setup();
    const got = await service.getMany(USER, [USERNAME, PASSWORD]);
    expect(Object.fromEntries(got)).toEqual({
      [USERNAME]: 'alice',
      [PASSWORD]: 'hunter2-password',
    });
  });

  it('answers null for a key with no row and still returns the others', async () => {
    const { service } = await setup();
    await service.delete(USER, PASSWORD);
    const got = await service.getMany(USER, [USERNAME, PASSWORD]);
    expect(Object.fromEntries(got)).toEqual({ [USERNAME]: 'alice', [PASSWORD]: null });
  });

  it('reads two names in one statement, so one commit cannot land between them', async () => {
    const { service, statements } = await setup();
    await service.getMany(USER, [USERNAME, PASSWORD]);
    expect(statements()).toBe(1);
  });

  it('reads through the transaction it is given, so the caller can join it to other reads', async () => {
    const { fake, service, statements } = await setup();
    const tx = createFakeDb({ userSecrets: schema.userSecrets });
    const inTx = vi.spyOn(tx.db.query.userSecrets, 'findMany');
    await service.getMany(USER, [USERNAME, PASSWORD], tx.db as never);
    expect(inTx).toHaveBeenCalledTimes(1);
    expect(statements()).toBe(0);
    expect(fake.rows(schema.userSecrets)).toHaveLength(3);
  });

  it('reads only the given user rows', async () => {
    const { service } = await setup();
    const got = await service.getMany(OTHER, [USERNAME, PASSWORD]);
    expect(Object.fromEntries(got)).toEqual({ [USERNAME]: 'mallory', [PASSWORD]: null });
  });

  it('fails the way get fails when a stored value cannot be decrypted', async () => {
    const { fake, service } = await setup();
    const row = fake.rows(schema.userSecrets).find((r) => r.keyName === PASSWORD)!;
    fake.patch(schema.userSecrets, row.id as string, { encryptedValue: 'not-an-envelope' });
    await expect(service.get(USER, PASSWORD)).rejects.toThrow('Failed to decrypt user secret');
    h.logger.error.mockClear();
    await expect(service.getMany(USER, [USERNAME, PASSWORD])).rejects.toThrow(
      'Failed to decrypt user secret',
    );
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, keyName: PASSWORD }),
      'Failed to decrypt user secret',
    );
  });
});
