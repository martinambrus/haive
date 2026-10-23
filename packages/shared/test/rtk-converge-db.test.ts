import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { RTK_ENABLED_UNIT, conflictSide } from '../src/project-state/index.js';
import { convergeRtkQuestion } from '../src/tooling/rtk-enabled.js';

const url = process.env.RTK_CONVERGE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/rtk_converge_test'))
  throw new Error('Use a dedicated rtk_converge_test database');

describe.skipIf(!url)('convergeRtkQuestion on Postgres', () => {
  let db: Database;
  let end: () => Promise<void>;
  const userId = randomUUID();
  const repositoryId = randomUUID();

  beforeAll(async () => {
    db = createDatabase(url!);
    end = () =>
      (db as unknown as { $client: { end(o: object): Promise<void> } }).$client.end({ timeout: 5 });
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'rtk-converge',
      emailBlindIndex: `rtk-converge-${randomBytes(6).toString('hex')}`,
      passwordHash: 'not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'rtk-converge',
      source: 'blank',
      rtkEnabled: false,
    });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await end();
  });

  const pending = async (base: boolean, local: boolean) => {
    await db
      .delete(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.repositoryId, repositoryId));
    await db.insert(schema.projectStateConflicts).values({
      repositoryId,
      unit: RTK_ENABLED_UNIT,
      base: conflictSide(base),
      local: conflictSide(local),
      incoming: conflictSide(false),
    });
    await convergeRtkQuestion(db, repositoryId, null);
    const [row] = await db
      .select()
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.repositoryId, repositoryId));
    return row!;
  };

  it('closes the question, whose base equals what this install holds', async () => {
    expect((await pending(true, true)).resolution).toBe('converged');
  });

  it('leaves an ordinary setting conflict between two installs pending', async () => {
    const row = await pending(true, false);
    expect(row.resolution).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });
});
