-- Per-task broad-audit toggle (default ON): gates the report-only broad spec
-- audit (04a-spec-audit) and code audit (08c2-code-audit) that run on top of the
-- narrow reviewers. Creation-time value, read by 04a before run-config runs.
-- Default true so the audits run unless the user opts out on the new-task form.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "broad_audit" boolean NOT NULL DEFAULT true;
