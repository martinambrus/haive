// The house-rules columns and clearing trigger against a real Postgres, in a scratch database.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createGlobalKbDb, ensureGlobalKbSchema, globalKbEntries } from '@haive/shared/global-kb';

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

const adminUrl = process.env.DATABASE_URL;
const TABLE = 'global_kb_entries';
const TRIGGER = 'trg_global_kb_clear_enforced_hash';
const COLUMNS = 'status, enforce, enforced_hash, enforced_at, enforced_by';
const APPROVED = 'hr1:approved';
const SETTINGS = JSON.stringify({ mode: 'always' });

interface Stored {
  status: string;
  enforce: unknown;
  enforced_hash: string | null;
  enforced_at: Date | null;
  enforced_by: string | null;
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`[smoke] ok   ${label}`);
  } else {
    console.error(
      `[smoke] FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
    failures.push(label);
  }
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const created: string[] = [];

async function freshDatabase(): Promise<string> {
  const name = `haive_house_rules_smoke_${process.pid}`;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created.push(name);
  return name;
}

async function main(): Promise<void> {
  const dbName = await freshDatabase();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pg = postgres(url.toString(), { max: 2, onnotice: () => {} });
  // drizzle() rewrites the client it wraps (timestamps come back as strings), so it gets its own.
  const drizzlePg = postgres(url.toString(), { max: 1, onnotice: () => {} });

  const stored = async (id: string): Promise<Stored | undefined> =>
    (await pg.unsafe<Stored[]>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE id = $1`, [id]))[0];
  const seed = async (status: string, hash: string | null): Promise<string> => {
    const rows = await pg.unsafe<{ id: string }[]>(
      `INSERT INTO ${TABLE} (namespace, title, body, category, status, source, enforce, enforced_hash, enforced_at, enforced_by)
       VALUES ('smoke', 'T', 'B', 'general', $1, 'user', '${SETTINGS}'::jsonb, $2, now(), gen_random_uuid())
       RETURNING id`,
      [status, hash],
    );
    return rows[0]!.id;
  };
  const settingsKept = (row: Stored | undefined): boolean =>
    JSON.stringify(row?.enforce) === SETTINGS &&
    row?.enforced_at instanceof Date &&
    typeof row.enforced_by === 'string';
  const triggerCount = async (): Promise<string | undefined> =>
    (
      await pg.unsafe<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM pg_trigger
          WHERE tgname = '${TRIGGER}' AND tgrelid = '${TABLE}'::regclass AND NOT tgisinternal`,
      )
    )[0]?.n;

  try {
    const conn = { pg, embeddingDimensions: 8 };
    await ensureGlobalKbSchema(conn);
    await ensureGlobalKbSchema(conn);

    check('ensure twice: exactly one clearing trigger', (await triggerCount()) === '1');
    const columns = await pg.unsafe<
      { column_name: string; data_type: string; is_nullable: string }[]
    >(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = '${TABLE}'
          AND column_name IN ('enforce', 'enforced_hash', 'enforced_at', 'enforced_by')
        ORDER BY column_name`,
    );
    check(
      'ensure twice: the four columns exist, typed, and nullable',
      JSON.stringify(columns.map((c) => [c.column_name, c.data_type, c.is_nullable])) ===
        JSON.stringify([
          ['enforce', 'jsonb', 'YES'],
          ['enforced_at', 'timestamp without time zone', 'YES'],
          ['enforced_by', 'uuid', 'YES'],
          ['enforced_hash', 'text', 'YES'],
        ]),
      columns,
    );
    const [index] = await pg.unsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = '${TABLE}' AND indexname = 'idx_global_kb_entries_ns_enforced'`,
    );
    check(
      'ensure twice: the partial index keys on the hash',
      /\(namespace\) WHERE \(enforced_hash IS NOT NULL\)/.test(index?.indexdef ?? ''),
      index,
    );

    const left = await seed('active', APPROVED);
    const archived = await pg.unsafe<Stored[]>(
      `UPDATE ${TABLE} SET status = 'archived' WHERE id = $1 RETURNING ${COLUMNS}`,
      [left],
    );
    check(
      'T1 active -> archived: RETURNING reads the hash as NULL',
      archived[0]?.status === 'archived' && archived[0].enforced_hash === null,
      archived[0],
    );
    check(
      'T1 active -> archived: the approved settings, time and admin are kept',
      settingsKept(archived[0]),
      archived[0],
    );
    check(
      'T1 active -> archived: RETURNING is the stored row',
      JSON.stringify(archived[0]) === JSON.stringify(await stored(left)),
    );
    const back = await pg.unsafe<Stored[]>(
      `UPDATE ${TABLE} SET status = 'active' WHERE id = $1 RETURNING ${COLUMNS}`,
      [left],
    );
    check(
      'T2 archived -> active: the hash is not restored',
      back[0]?.status === 'active' && back[0].enforced_hash === null && settingsKept(back[0]),
      back[0],
    );

    const cases: Array<{
      label: string;
      hash: string | null;
      statement: string;
      status: string;
      hashAfter: string | null;
    }> = [
      {
        label: 'T3 a body edit, status not in SET: the hash is kept',
        hash: APPROVED,
        statement: `UPDATE ${TABLE} SET body = 'edited' WHERE id = $1 RETURNING ${COLUMNS}`,
        status: 'active',
        hashAfter: APPROVED,
      },
      {
        label: "T4 SET status = 'active' on an active row: the hash is kept",
        hash: APPROVED,
        statement: `UPDATE ${TABLE} SET status = 'active' WHERE id = $1 RETURNING ${COLUMNS}`,
        status: 'active',
        hashAfter: APPROVED,
      },
      {
        label: 'T5 active -> enriching (the enrich step demotion): the hash is cleared',
        hash: APPROVED,
        statement: `UPDATE ${TABLE} SET status = 'enriching' WHERE id = $1 RETURNING ${COLUMNS}`,
        status: 'enriching',
        hashAfter: null,
      },
      {
        label: 'T6 leaving active AND setting a hash in one statement: the hash is cleared',
        hash: APPROVED,
        statement: `UPDATE ${TABLE} SET status = 'archived', enforced_hash = 'hr1:forged' WHERE id = $1 RETURNING ${COLUMNS}`,
        status: 'archived',
        hashAfter: null,
      },
      {
        label: 'T7 setting a hash on an active row: it is kept',
        hash: null,
        statement: `UPDATE ${TABLE} SET enforced_hash = '${APPROVED}' WHERE id = $1 RETURNING ${COLUMNS}`,
        status: 'active',
        hashAfter: APPROVED,
      },
      {
        label: 'T9 INSERT ... ON CONFLICT DO UPDATE SET status: the hash is cleared',
        hash: APPROVED,
        statement: `INSERT INTO ${TABLE} (id, namespace, title, body, category, status, source)
                    VALUES ($1, 'smoke', 'T', 'B', 'general', 'draft', 'user')
                    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
                    RETURNING ${COLUMNS}`,
        status: 'draft',
        hashAfter: null,
      },
    ];
    for (const c of cases) {
      const id = await seed('active', c.hash);
      const returned = await pg.unsafe<Stored[]>(c.statement, [id]);
      const after = await stored(id);
      check(
        `${c.label} (RETURNING)`,
        returned[0]?.status === c.status && returned[0].enforced_hash === c.hashAfter,
        returned[0],
      );
      check(
        `${c.label} (stored, and it agrees with RETURNING)`,
        JSON.stringify(returned[0]) === JSON.stringify(after),
        {
          returned: returned[0],
          after,
        },
      );
    }

    const enforced = await seed('active', APPROVED);
    const guarded = await pg.unsafe<{ id: string }[]>(
      `UPDATE ${TABLE} SET status = 'enriching' WHERE id = $1 AND enforced_hash IS NULL RETURNING id`,
      [enforced],
    );
    const untouched = await stored(enforced);
    check(
      'T8 the guarded demotion matches no row on an enforced entry, which stays active and approved',
      guarded.length === 0 &&
        untouched?.status === 'active' &&
        untouched.enforced_hash === APPROVED,
      { guarded, untouched },
    );

    const gdb = createGlobalKbDb(drizzlePg);
    const settings = { mode: 'files' as const, globs: ['**/*.twig'] };
    const [inserted] = await gdb
      .insert(globalKbEntries)
      .values({
        namespace: 'smoke',
        title: 'D',
        body: 'B',
        category: 'general',
        status: 'active',
        source: 'user',
        enforce: settings,
        enforcedHash: APPROVED,
        enforcedAt: new Date(),
        enforcedBy: randomUUID(),
      })
      .returning();
    check(
      'drizzle: an insert round-trips the four columns',
      inserted?.enforcedHash === APPROVED &&
        JSON.stringify(inserted.enforce) === JSON.stringify(settings) &&
        inserted.enforcedAt instanceof Date &&
        typeof inserted.enforcedBy === 'string',
      inserted,
    );
    const [demoted] = await gdb
      .update(globalKbEntries)
      .set({ status: 'archived' })
      .where(eq(globalKbEntries.id, inserted!.id))
      .returning();
    check(
      'drizzle: .returning() after leaving active reads the hash as null and keeps the settings',
      demoted?.enforcedHash === null &&
        JSON.stringify(demoted.enforce) === JSON.stringify(settings) &&
        demoted.enforcedAt instanceof Date,
      demoted,
    );

    const survivor = await seed('active', APPROVED);
    await ensureGlobalKbSchema(conn);
    const survived = await stored(survivor);
    check(
      'ensure over data: still one trigger, and an approved row keeps its hash and settings',
      (await triggerCount()) === '1' &&
        survived?.enforced_hash === APPROVED &&
        settingsKept(survived),
      survived,
    );
  } finally {
    await drizzlePg.end({ timeout: 5 });
    await pg.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (err) {
  console.error('[smoke] threw', err);
  failures.push('unexpected exception');
} finally {
  for (const name of created) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 });
}

if (failures.length > 0) {
  console.error(`[smoke] ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('[smoke] house-rules-storage: all checks passed');
