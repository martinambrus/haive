// Run against an isolated PostgreSQL database, never the development stack.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const postgres = require('postgres').default;
const url = process.env.RAG_ATTRIBUTION_TEST_URL;
assert(url, 'Set RAG_ATTRIBUTION_TEST_URL to a disposable PostgreSQL database');
const db = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
const namespace = `rag_attribution_${randomUUID().replaceAll('-', '')}`;
const migration = await readFile(
  new URL('../packages/database/migrations/0247_rag_invocation_attribution.sql', import.meta.url),
  'utf8',
);
try {
  await db.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA ${namespace}`);
    await tx.unsafe(`SET LOCAL search_path TO ${namespace}`);
    await tx.unsafe('CREATE TABLE cli_invocations (id uuid PRIMARY KEY)');
    await tx.unsafe('CREATE TABLE rag_query_log (id uuid PRIMARY KEY, query text NOT NULL)');
    const legacy = randomUUID();
    await tx`INSERT INTO rag_query_log VALUES (${legacy}, 'legacy query')`;
    await tx.unsafe(migration);
    const columns = await tx`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ${namespace} AND table_name = 'rag_query_log'
      ORDER BY ordinal_position`;
    assert.deepEqual(columns.at(-1), {
      column_name: 'cli_invocation_id',
      is_nullable: 'YES',
      column_default: null,
    });
    const [oldRow] = await tx`SELECT * FROM rag_query_log WHERE id = ${legacy}`;
    assert.equal(oldRow.query, 'legacy query');
    assert.equal(oldRow.cli_invocation_id, null);
    const invocation = randomUUID();
    await tx`INSERT INTO cli_invocations VALUES (${invocation})`;
    await tx`INSERT INTO rag_query_log VALUES (${randomUUID()}, 'attributed', ${invocation})`;
    // Replaying against an ahead schema must preserve already-attributed rows too.
    await tx.unsafe(migration);
    const [attributed] = await tx`SELECT * FROM rag_query_log WHERE query = 'attributed'`;
    assert.equal(attributed.cli_invocation_id, invocation);
    const [fk] = await tx`
      SELECT confdeltype FROM pg_constraint
      WHERE conrelid = 'rag_query_log'::regclass AND contype = 'f'`;
    assert.equal(fk.confdeltype, 'n');
    await tx`DELETE FROM cli_invocations WHERE id = ${invocation}`;
    const [deleted] = await tx`SELECT * FROM rag_query_log WHERE query = 'attributed'`;
    assert.equal(deleted.cli_invocation_id, null);
    await tx.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
  });
  console.log(
    'PASS: legacy NULL, last nullable/no-default column, guarded replay preserves attribution, deletion sets NULL',
  );
} finally {
  await db.end({ timeout: 5 });
}
