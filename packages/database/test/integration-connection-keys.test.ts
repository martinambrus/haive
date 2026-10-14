import { randomBytes, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, isUniqueViolationOf, schema, type Database } from '../src/index.js';

const url = process.env.INTEGRATION_KEYS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_keys_test'))
  throw new Error('Use a dedicated integration_keys_test database for the integration key tests');

const ACCOUNT_KEY = 'integration_connections_account_key_idx';
const CREDENTIAL_KEY = 'integration_connections_repo_credential_key_idx';

describe.skipIf(!url)('integration connection keys on Postgres', () => {
  let db: Database;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'keys-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function createCredential(userId: string): Promise<string> {
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: `credential ${randomUUID()}`,
        host: 'github.com',
        usernameEncrypted: 'x',
        secretEncrypted: 'x',
        encryptedDek: 'x',
      })
      .returning({ id: schema.repoCredentials.id });
    return credential!.id;
  }

  const connection = (
    ownerUserId: string,
    over: Partial<typeof schema.integrationConnections.$inferInsert> = {},
  ) =>
    db.insert(schema.integrationConnections).values({
      providerId: 'github',
      scope: 'user',
      ownerUserId,
      accountLabel: 'octocat',
      authMethod: 'device',
      ...over,
    });

  const rejection = (pending: PromiseLike<unknown>): Promise<unknown> =>
    Promise.resolve(pending).then(
      () => null,
      (err: unknown) => err,
    );

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('refuses a second connection to the same account of one provider for one owner and scope', async () => {
    const owner = await createUser();
    await connection(owner, { externalAccountId: '583231' });
    const err = await rejection(connection(owner, { externalAccountId: '583231' }));
    expect(isUniqueViolationOf(err, ACCOUNT_KEY)).toBe(true);
  });

  it('allows the same account under another owner, scope, provider or account id', async () => {
    const owner = await createUser();
    const other = await createUser();
    await connection(owner, { externalAccountId: '900' });
    await connection(other, { externalAccountId: '900' });
    await connection(owner, { externalAccountId: '900', scope: 'shared' });
    await connection(owner, { externalAccountId: '900', providerId: 'gitlab' });
    await connection(owner, { externalAccountId: '901' });
  });

  it('does not constrain connections that have no external account id', async () => {
    const owner = await createUser();
    await connection(owner);
    await connection(owner);
    await connection(owner, { externalAccountId: null });
  });

  it('refuses a second connection to the same Git credential', async () => {
    const owner = await createUser();
    const credential = await createCredential(owner);
    await connection(owner, { repoCredentialId: credential });
    const err = await rejection(connection(owner, { repoCredentialId: credential }));
    expect(isUniqueViolationOf(err, CREDENTIAL_KEY)).toBe(true);
  });

  it('allows connections to different Git credentials and any number without one', async () => {
    const owner = await createUser();
    await connection(owner, { repoCredentialId: await createCredential(owner) });
    await connection(owner, { repoCredentialId: await createCredential(owner) });
    await connection(owner, { repoCredentialId: null });
    await connection(owner, { repoCredentialId: null });
  });
});
