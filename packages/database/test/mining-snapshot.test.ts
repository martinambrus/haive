import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.MINING_SNAPSHOT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/mining_snapshot_test'))
  throw new Error('Use a dedicated mining_snapshot_test database');

describe.skipIf(!url)('additive mining snapshot columns', () => {
  const db = url ? postgres(url, { max: 1 }) : undefined;
  afterAll(async () => {
    await db?.end({ timeout: 5 });
  });
  it.each([false, true])(
    'replays without a default or backfill (schema already ahead: %s)',
    async (ahead) => {
      const migration = await readFile(
        new URL('../migrations/0242_mining_snapshot_refs.sql', import.meta.url),
        'utf8',
      );
      // An isolated schema exercises the actual unqualified migration SQL without altering public rows.
      const namespace = `snapshot_${randomUUID().replaceAll('-', '')}`;
      await db!.begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA ${namespace}`);
        await tx.unsafe(`SET LOCAL search_path TO ${namespace}`);
        await tx.unsafe(
          'CREATE TABLE task_step_agent_minings (id text PRIMARY KEY, dispatch_prompt text)',
        );
        await tx.unsafe("INSERT INTO task_step_agent_minings VALUES ('legacy', 'keep prompt')");
        if (ahead) {
          await tx.unsafe(
            'ALTER TABLE task_step_agent_minings ADD COLUMN snapshot_ref jsonb, ADD COLUMN base_snapshot_ref jsonb',
          );
          await tx.unsafe(
            `INSERT INTO task_step_agent_minings VALUES ('pinned', 'keep pin', '{"identity":"target"}', '{"identity":"base"}')`,
          );
        }
        await tx.unsafe(migration);
        await tx.unsafe(migration);
        const columns =
          await tx`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${namespace} AND table_name = 'task_step_agent_minings' ORDER BY ordinal_position`;
        expect(columns.slice(-2)).toEqual([
          { column_name: 'snapshot_ref', is_nullable: 'YES', column_default: null },
          { column_name: 'base_snapshot_ref', is_nullable: 'YES', column_default: null },
        ]);
        const [legacy] = await tx`SELECT * FROM task_step_agent_minings WHERE id = 'legacy'`;
        expect(legacy).toMatchObject({
          dispatch_prompt: 'keep prompt',
          snapshot_ref: null,
          base_snapshot_ref: null,
        });
        if (ahead) {
          const [pinned] = await tx`SELECT * FROM task_step_agent_minings WHERE id = 'pinned'`;
          expect(pinned).toMatchObject({
            snapshot_ref: { identity: 'target' },
            base_snapshot_ref: { identity: 'base' },
          });
        }
        await tx.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
      });
    },
  );
  it('the migrated public table appends both refs after dispatch_prompt', async () => {
    const columns =
      await db!`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'task_step_agent_minings' ORDER BY ordinal_position`;
    expect(columns.slice(-3).map((c) => c.column_name)).toEqual([
      'dispatch_prompt',
      'snapshot_ref',
      'base_snapshot_ref',
    ]);
  });
});
