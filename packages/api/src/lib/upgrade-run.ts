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
  started_at: Date;
  ended_at: Date | null;
};

type UpgradeRunDb = Pick<DbTx, 'execute'>;

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
    sql`SELECT id, from_version, to_version, phase, status, error, started_at, ended_at
            FROM upgrade_runs ORDER BY started_at DESC LIMIT 20`,
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
