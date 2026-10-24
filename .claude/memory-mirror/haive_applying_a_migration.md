---
name: haive-applying-a-migration
description: 'How to add and apply a Haive schema change - `pnpm docker migrate` runs the real runner; host `pnpm db:push` cannot reach the DB'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4b6135f7-23c5-4273-8475-8a8b973bb5a4
  modified: 2026-09-26T21:00:28.380Z
---

Since 2026-09-08 (`c5634e35`..`f6a24f7f`) Haive has a real migration runner, and the previous
advice here — psql the .sql into the container by hand, because the files are only a parity
record — is obsolete.

**To land a schema change:**

1. Edit `packages/database/src/schema/*.ts` (still the artifact everything derives from).
2. Iterate locally with `pnpm db:push` if you want, but note it cannot connect from the host:
   `.env` sets `DATABASE_URL=postgres://haive:…@postgres:5432/haive`, and `postgres` is the
   compose service hostname. Override the URL to `localhost:5432` (the port IS published) or run
   it in a container.
3. Write `packages/database/migrations/NNNN_name.sql` — note the path, it moved out of `src/`.
   Keep the guarded idempotent style (`ADD COLUMN IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN
duplicate_object`): a developer's DB is often legitimately AHEAD of the baseline.
4. `pnpm docker migrate` applies only the PENDING files, one transaction each.

**Two traps:**

- **Never edit an applied migration**, including its comments. Its sha256 is in
  `schema_migrations` and a change hard-fails every install that ran it (exit 4, with the
  recovery UPDATE printed).
- **`pnpm db:push` will offer to DROP `schema_migrations`.** That table is deliberately outside
  the Drizzle barrel — that is what makes its existence honest evidence the runner created it.
  Accepting is recoverable (the next `migrate` re-adopts) but never what you want.

**A migration's DATA step is testable on a real DB** (used on #339's 0168): add a case to
`packages/database/test/migrate-smoke.ts` (CI runs `smoke:migrate`) that copies the files sorted
before yours into a temp dir, runs the runner with `HAIVE_MIGRATIONS_DIR=<dir>/` on a
`freshDatabase`, seeds the rows your migration must settle, then runs the full corpus and asserts.
A prefix corpus on a fresh DB is fine (only a DB migrated AHEAD of the dir is a "fork"). Control =
the same smoke with the previous migration body temporarily in place.

`migrations/pre-baseline/` holds the 152 files written before the directory was executable.
Nothing runs them, and nothing should: 19 are not re-runnable and `0006` would delete the live
grok provider. `0000_baseline.sql` is generated and FROZEN.

Related: [[haive-libs-build-host-vs-docker]], [[haive-host-build-restarts-worker]].
