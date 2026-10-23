import { sql } from 'drizzle-orm';
import type { DbTx } from '@haive/database';

export interface LiveUpgradeRun {
  id: string;
  fromVersion: string;
  toVersion: string;
  phase: string;
}

export async function findLiveUpgradeRun(tx: DbTx): Promise<LiveUpgradeRun | null> {
  // The updater creates upgrade_runs, and a failed SELECT would abort the transaction.
  const probe = (await tx.execute<{ present: boolean }>(
    sql`SELECT to_regclass('upgrade_runs') IS NOT NULL AS present`,
  )) as unknown as { present: boolean }[];
  if (!probe[0]?.present) return null;
  const rows = (await tx.execute<{
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
