import type { Sql } from 'postgres';
import type { RunStatus, UpgradePhase } from './phases.js';

/** Metadata is written to a jsonb column and read back by a human and by a resumed run, so it is
 *  deliberately JSON-shaped rather than `unknown`: anything that cannot survive a round trip
 *  through the column has no business being recorded as the state of an upgrade. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type RunMetadata = Record<string, JsonValue>;

/**
 * The upgrade journal.
 *
 * Self-created with `CREATE TABLE IF NOT EXISTS`, not by a migration and not from the Drizzle
 * barrel — and that is forced rather than chosen. The journal has to exist BEFORE the migrate
 * phase, so it cannot be something a migration creates; and it has to work against an install
 * whose schema predates it, which is every install that ever upgrades to the first version
 * carrying it.
 *
 * The partial unique index is the durable half of "one upgrade at a time". The advisory lock
 * prevents two updaters running concurrently, but it dies with its connection; the index survives
 * a crashed updater and is what makes a second one FIND the interrupted run instead of starting a
 * competing one.
 */
export const UPGRADE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS "upgrade_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_version" text NOT NULL,
  "to_version" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'public',
  "phase" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "ended_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_runs_one_live_idx"
  ON "upgrade_runs" ((1)) WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "upgrade_runs_started_at_idx" ON "upgrade_runs" ("started_at");
`;

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
