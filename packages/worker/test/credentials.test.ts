import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { encrypt, encryptDek, generateDek, secretsService } from '@haive/shared';
import { getDecryptedCredentials } from '../src/repo/credentials.js';

const KEK = 'ab'.repeat(32);
vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);

const dbReading = (row: unknown) =>
  ({ query: { repoCredentials: { findFirst: async () => row } } }) as unknown as Database;

describe('getDecryptedCredentials', () => {
  it('returns the username, secret and host of the row it reads', async () => {
    const dek = generateDek();
    const db = dbReading({
      host: 'git.corp',
      usernameEncrypted: encrypt('alice', dek),
      secretEncrypted: encrypt('s3cret', dek),
      encryptedDek: encryptDek(dek, KEK),
    });

    await expect(getDecryptedCredentials(db, 'cred-1', 'user-1')).resolves.toEqual({
      username: 'alice',
      secret: 's3cret',
      host: 'git.corp',
    });
  });

  it('throws when no credential matches', async () => {
    await expect(getDecryptedCredentials(dbReading(undefined), 'cred-1', 'user-1')).rejects.toThrow(
      'Credentials not found',
    );
  });
});
