import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '../src/index.js';

const url = process.env.REPO_CREDENTIAL_SIGN_IN_ACCOUNT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_credential_sign_in_account_test'))
  throw new Error(
    'Use a dedicated repo_credential_sign_in_account_test database for the sign-in account marker tests',
  );

const MIGRATION = readFileSync(
  new URL('../migrations/0216_repo_credentials_sign_in_account.sql', import.meta.url),
  'utf8',
);

describe.skipIf(!url)('repo_credentials.sign_in_account_id on Postgres', () => {
  let db: Database;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'sign-in-account-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function createCredential(userId: string, marker: string | null = null): Promise<string> {
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: 'credential',
        host: 'github.com',
        usernameEncrypted: 'x',
        secretEncrypted: 'x',
        encryptedDek: 'x',
        signInAccountId: marker,
      })
      .returning({ id: schema.repoCredentials.id });
    return credential!.id;
  }

  const connect = (
    ownerUserId: string,
    repoCredentialId: string,
    over: Partial<typeof schema.integrationConnections.$inferInsert>,
  ) =>
    db.insert(schema.integrationConnections).values({
      providerId: 'github',
      scope: 'user',
      ownerUserId,
      accountLabel: 'octocat',
      authMethod: 'device',
      repoCredentialId,
      ...over,
    });

  const markerOf = async (id: string) => {
    const [row] = await db
      .select({ marker: schema.repoCredentials.signInAccountId })
      .from(schema.repoCredentials)
      .where(eq(schema.repoCredentials.id, id));
    return row!.marker;
  };

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('is a nullable text column on the credentials table', async () => {
    const rows = await db.execute<{ data_type: string; is_nullable: string }>(
      sql`select data_type, is_nullable from information_schema.columns where table_name = 'repo_credentials' and column_name = 'sign_in_account_id'`,
    );
    expect([...rows]).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  it('marks the credential behind a signed-in connection and no other', async () => {
    const owner = await createUser();
    const signedIn = await createCredential(owner);
    const linked = await createCredential(owner);
    const typed = await createCredential(owner);
    const alreadyMarked = await createCredential(owner, 'kept');
    await connect(owner, signedIn, { externalAccountId: '4242' });
    await connect(owner, linked, { authMethod: 'token', externalAccountId: null });
    await connect(owner, alreadyMarked, { externalAccountId: '999' });

    await db.execute(sql.raw(MIGRATION));

    expect(await markerOf(signedIn)).toBe('4242');
    expect(await markerOf(linked)).toBeNull();
    expect(await markerOf(typed)).toBeNull();
    expect(await markerOf(alreadyMarked)).toBe('kept');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const owner = await createUser();
    const signedIn = await createCredential(owner);
    await connect(owner, signedIn, { externalAccountId: '7' });
    await db.execute(sql.raw(MIGRATION));
    await db.execute(sql.raw(MIGRATION));
    expect(await markerOf(signedIn)).toBe('7');
  });
});
