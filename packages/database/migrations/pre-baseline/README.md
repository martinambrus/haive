# Pre-baseline migrations — history, not inputs

**Nothing executes these files.** They are kept as the parity and rollback record they always were:
each one documents, in its own header, why a schema change was made and how to undo it. The schema
they collectively describe is captured in `../0000_baseline.sql`, which is what the migration runner
actually applies to a fresh database.

They were never executed. Before the runner existed the applier was `drizzle-kit push --force`, which
diffs the Drizzle barrel against the live database; these files were written alongside it by hand as
a record. That is why the corpus has no genesis migration — nothing here creates `users`, `tasks`,
`repositories`, `cli_providers`, `task_steps` or `cli_invocations`, and `0001` opens with
`UPDATE tasks …` against a schema only `push` had ever created.

## Why they cannot simply be replayed

Replaying them against a database is not merely redundant, it is unsafe:

- **19 of 152 are not safely re-runnable.** 18 hard-error on a second run — bare `ADD COLUMN`,
  `CREATE TABLE`, `CREATE TYPE`, `CREATE INDEX` with no guard — and all 18 are in `0001`–`0021`, a
  pre-convention era. From `0022` onward every file is guarded (`IF NOT EXISTS`, `DO $$ … EXCEPTION
WHEN duplicate_object`, `ALTER TYPE … ADD VALUE IF NOT EXISTS`).
- **`0006_drop_legacy_cli_providers.sql` would destroy live data.** Its
  `DELETE FROM cli_providers WHERE name IN ('grok','qwen','kiro')` now targets `grok`, which `0116`
  re-added as a real provider, and it narrows the `cli_provider_name` enum back to five labels,
  dropping the five that `0022`/`0042`/`0110`/`0116`/`0117` added.
- **`0094_pr_workflow_default_on.sql:20`** runs clean and produces a WRONG result. Its own header
  says so: the `UPDATE` is a one-time adoption backfill, not idempotent against an operator who has
  since turned the feature off deliberately.

## Two sequence defects, both harmless now

- **`0065` does not exist.** A gap, never created. Nothing computes an expected next number, so it
  has no consequence.
- **`0142` is used twice** — `0142_review_dimensions.sql` and `0142_task_summary_cli.sql`, two
  branches landing on the same day. Lexical order inverts commit order here (`task_summary_cli`
  landed first, `review_dimensions` sorts first). Harmless because the two are independent and
  neither will ever be applied. The runner's journal is keyed by filename stem rather than a parsed
  integer precisely so this shape stays representable, and `assertNoDuplicatePrefix()` now rejects it
  for any _live_ migration at CI time.

## Adding a migration

New migrations go in the parent directory as `0153_*.sql` onward, where the runner will apply them.
Keep the guarded, idempotent style of `0022`–`0152`: a database that is legitimately ahead of the
baseline must survive them.
