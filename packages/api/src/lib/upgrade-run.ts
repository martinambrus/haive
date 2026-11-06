import { sql } from 'drizzle-orm';
import type { DbTx } from '@haive/database';

export interface LiveUpgradeRun {
  id: string;
  fromVersion: string;
  toVersion: string;
  phase: string;
}

// A type alias, not an interface: `db.execute<T>` constrains T to `Record<string, unknown>`, and
// only a type literal picks up the implicit index signature that satisfies it.
export type UpgradeRunRow = {
  id: string;
  from_version: string;
  to_version: string;
  phase: string;
  status: string;
  error: string | null;
  started_at: string;
  ended_at: string | null;
};

type UpgradeRunDb = Pick<DbTx, 'execute'>;

const attemptRow = sql`phase = 'preflight' AND status IN ('refused', 'failed')`;

// These timestamp columns hold now() in the session TimeZone's wall clock. Convert in SQL,
// before any driver parser can mistake it for UTC, and return text with an explicit offset.
const instant = (column: 'started_at' | 'ended_at') => sql`to_char(
  ${sql.identifier(column)} AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

async function journalExists(db: UpgradeRunDb): Promise<boolean> {
  // The updater creates upgrade_runs, and a failed SELECT would abort the transaction.
  const probe = (await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('upgrade_runs') IS NOT NULL AS present`,
  )) as unknown as { present: boolean }[];
  return !!probe[0]?.present;
}

export async function listUpgradeRuns(db: UpgradeRunDb): Promise<UpgradeRunRow[]> {
  if (!(await journalExists(db))) return [];
  const rows = await db.execute<UpgradeRunRow>(
    sql`WITH history AS (
          (SELECT * FROM upgrade_runs WHERE NOT (${attemptRow})
           ORDER BY started_at DESC, id DESC LIMIT 20)
          UNION ALL
          (SELECT * FROM upgrade_runs WHERE ${attemptRow}
           ORDER BY started_at DESC, id DESC LIMIT 10)
        )
        SELECT id, from_version, to_version, phase, status, error, ${instant('started_at')} AS started_at,
           ${instant('ended_at')} AS ended_at
            FROM history ORDER BY history.started_at DESC, id DESC`,
  );
  return rows as unknown as UpgradeRunRow[];
}

export async function findLiveUpgradeRun(db: UpgradeRunDb): Promise<LiveUpgradeRun | null> {
  if (!(await journalExists(db))) return null;
  const rows = (await db.execute<{
    id: string;
    from_version: string;
    to_version: string;
    phase: string;
  }>(
    sql`SELECT id, from_version, to_version, phase FROM upgrade_runs WHERE status = 'running' LIMIT 1`,
  )) as unknown as { id: string; from_version: string; to_version: string; phase: string }[];
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, fromVersion: row.from_version, toVersion: row.to_version, phase: row.phase };
}

export interface UpgradeAttempt {
  status: 'refused' | 'failed';
  refusal: string | null;
  error: string | null;
  startedAt: string;
  toVersion: string;
  channel: string;
}

/** Read independently of the capped history: many refusals must not hide a newer real run. */
export async function lastUpgradeAttempt(db: UpgradeRunDb): Promise<UpgradeAttempt | null> {
  if (!(await journalExists(db))) return null;
  const rows = (await db.execute<UpgradeRunRow & { channel: string; refusal: string | null }>(sql`
    SELECT id, from_version, to_version, channel, phase, status, error, ${instant('started_at')} AS started_at,
           ${instant('ended_at')} AS ended_at,
           metadata ->> 'refusal' AS refusal
      FROM upgrade_runs
     WHERE status IN ('done', 'running', 'rolled_back')
        OR (${attemptRow})
     ORDER BY started_at DESC,
              CASE WHEN status IN ('done', 'running', 'rolled_back') THEN 0 ELSE 1 END,
              id DESC LIMIT 1
  `)) as unknown as (UpgradeRunRow & { channel: string; refusal: string | null })[];
  const row = rows[0];
  if (!row || row.phase !== 'preflight' || (row.status !== 'refused' && row.status !== 'failed'))
    return null;
  return {
    status: row.status,
    refusal: row.refusal ?? null,
    error: row.error,
    startedAt: row.started_at,
    toVersion: row.to_version,
    channel: row.channel,
  };
}
