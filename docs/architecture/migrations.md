# Database migrations

The Drizzle schema lives in `packages/database/src/schema/`. Migrations are hand-written SQL in
`packages/database/migrations/`, applied in filename order by the runner in
`packages/database/src/migrate/` (`pnpm --filter @haive/database migrate`; the `db-migrate`
compose one-shot and CI both run it). Each file runs in one transaction with its
`schema_migrations` row (id and sha256) written inside it. A file whose first 20 lines carry
`-- haive:no-transaction` runs outside a transaction and is journalled right after
(`directives.ts`); only `CREATE INDEX CONCURRENTLY` needs it, and no file declares it today.

## Adding one

- Iterate with `pnpm db:push` (dev only), then write `NNNN_name.sql`. The CI `schema-parity`
  job compares the two and goes red if they disagree.
- Keep the guarded idempotent style (`ADD COLUMN IF NOT EXISTS`,
  `DO $$ … EXCEPTION WHEN duplicate_object`): a developer's database is often legitimately AHEAD
  of the baseline and must survive the file.
- Declare a new column LAST in its Drizzle table. `ALTER TABLE ADD COLUMN` appends while
  `drizzle-kit push` builds the table in declaration order, so a column declared anywhere else
  makes the two schemas differ by column ORDER and turns `schema-parity` red, a failure no
  migration can fix.

## What may never change

- **Never edit an applied migration.** Its sha256 is recorded; a changed file hard-fails every
  install that ran it (exit 4) and nothing is applied while any file is in dispute (`plan.ts`).
- **Never delete or revert an applied migration.** A database that applied a migration this code
  lacks is AHEAD: with nothing pending that is a rollback to older images, so the runner warns and
  continues (`ahead`). Once this code also has a migration the database has not applied, the same
  database is a fork, and the runner refuses it (exit 7, `migrate/index.ts` "That is a fork, not
  an upgrade"). Removing a migration from the code therefore breaks every install that ran it at
  the next added migration.
- **Rollback after apply is roll-forward only.** Undo a shipped migration with a new numbered
  migration that reverses it, never by removing the file. Older images still run against the
  newer database (the `ahead` case), so an additive migration needs no undo for an image
  rollback; split a destructive change into an additive phase and a later destructive one.
- `0000_baseline.sql` is generated and FROZEN. Re-cutting the schema means a later numbered
  baseline, never an edit to that one.
- `pre-baseline/` is the record written before the directory was executable and is NEVER run; see
  its README: 19 of those files are unsafe to replay and one is destructive.

## Baseline adoption and dropped tables

A database with our schema and no journal (one built by the old `push --force` applier, or whose
journal `push` dropped) is `legacy`: the runner stamps the baseline as applied without running it,
then applies the rest (`adoption.ts`). It decides that by comparing the live tables and columns
with the ones `0000_baseline.sql` creates (`baseline.ts`); a database with some of them but
not all, or missing a baseline column, is `indeterminate` and refused (exit 3).

A migration that drops a baseline table must add that table to `DROPPED_SINCE_BASELINE`
(`migrate/baseline.ts`) in the same change. Otherwise a journal-less database built from a barrel
that no longer declares the table reads as half-built and is refused. `baseline.test.ts` pins the
list to the corpus. A database that still has the table is fine: extra tables are allowed, and the
dropping migration removes it.

## Runner exit codes

`0` ok, `1` unexpected, `2` usage, `3` indeterminate database, `4` checksum mismatch, `5` lock
busy, `6` lock lost, `7` fork (`migrate/index.ts` `EXIT`).
