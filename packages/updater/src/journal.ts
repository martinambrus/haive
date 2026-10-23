import { UPGRADE_JOURNAL_DDL } from '@haive/database';
import { parseMaintenanceState, type MaintenanceState } from '@haive/shared';
import type { Sql } from 'postgres';
import type { RunStatus, UpgradePhase } from './phases.js';

/** Metadata is written to a jsonb column and read back by a human and by a resumed run, so it is
 *  deliberately JSON-shaped rather than `unknown`: anything that cannot survive a round trip
 *  through the column has no business being recorded as the state of an upgrade. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type RunMetadata = Record<string, JsonValue>;

export interface UpgradeRun {
  id: string;
  fromVersion: string;
  toVersion: string;
  channel: string;
  phase: UpgradePhase;
  status: RunStatus;
  error: string | null;
  metadata: RunMetadata;
  startedAt: Date;
}

export async function ensureJournal(sql: Sql): Promise<void> {
  await sql.unsafe(UPGRADE_JOURNAL_DDL, [], { simple: true } as Parameters<Sql['unsafe']>[2]);
}

/** The interrupted run, if any. At most one can exist — the partial unique index says so. */
export async function findLiveRun(sql: Sql): Promise<UpgradeRun | null> {
  const rows = await sql<
    {
      id: string;
      from_version: string;
      to_version: string;
      channel: string;
      phase: string;
      status: string;
      error: string | null;
      metadata: RunMetadata;
      started_at: Date;
    }[]
  >`SELECT * FROM upgrade_runs WHERE status = 'running' LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    channel: r.channel,
    phase: r.phase as UpgradePhase,
    status: r.status as RunStatus,
    error: r.error,
    metadata: r.metadata ?? {},
    startedAt: r.started_at,
  };
}

export async function startRun(
  sql: Sql,
  entry: { fromVersion: string; toVersion: string; channel: string; metadata?: RunMetadata },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO upgrade_runs (from_version, to_version, channel, phase, status, metadata)
    VALUES (${entry.fromVersion}, ${entry.toVersion}, ${entry.channel}, 'preflight', 'running',
            ${sql.json(entry.metadata ?? {})})
    RETURNING id`;
  return rows[0]!.id;
}

/** Record the phase BEFORE doing it. A journal written after the fact cannot say what was in
 *  progress when the process died, which is the only question it exists to answer. */
export async function enterPhase(sql: Sql, id: string, phase: UpgradePhase): Promise<void> {
  await sql`UPDATE upgrade_runs SET phase = ${phase}, updated_at = now() WHERE id = ${id}`;
}

export async function mergeMetadata(sql: Sql, id: string, patch: RunMetadata): Promise<void> {
  await sql`
    UPDATE upgrade_runs
       SET metadata = metadata || ${sql.json(patch)}, updated_at = now()
     WHERE id = ${id}`;
}

/** The right operand of jsonb `||` wins, so a state already recorded is never replaced. */
export async function recordFoundState(
  sql: Sql,
  id: string,
  state: MaintenanceState,
): Promise<void> {
  await sql`
    UPDATE upgrade_runs
       SET metadata = ${sql.json({ foundState: state })} || metadata, updated_at = now()
     WHERE id = ${id}`;
}

export async function readFoundState(sql: Sql, id: string): Promise<MaintenanceState> {
  const rows = await sql<{ found: string | null }[]>`
    SELECT metadata ->> 'foundState' AS found FROM upgrade_runs WHERE id = ${id}`;
  return parseMaintenanceState(rows[0]?.found);
}

export async function finishRun(
  sql: Sql,
  id: string,
  status: Exclude<RunStatus, 'running'>,
  error?: string,
): Promise<void> {
  await sql`
    UPDATE upgrade_runs
       SET status = ${status}, error = ${error ?? null}, ended_at = now(), updated_at = now()
     WHERE id = ${id}`;
}

const LOCK_KEY = 'haive:upgrade';

/** Session-scoped, like the migration runner's and for the same reason: the upgrade spans many
 *  transactions, so a transaction-scoped lock would release after the first one. */
export async function tryLock(sql: Sql): Promise<boolean> {
  const rows = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS locked`;
  return rows[0]?.locked === true;
}
