#!/usr/bin/env bash
# Prove that the migration path and `drizzle-kit push --force` produce the SAME schema.
#
# This is the check that lets the baseline be FROZEN. The baseline legitimately falls behind
# the schema barrel the moment the next numbered migration lands, so "regenerate it and diff
# the file" would fail by design. What must hold is END-STATE equivalence: build one database
# each way, dump both, diff.
#
# Run locally:   bash packages/database/scripts/schema-parity.sh
# Run in CI:     PG_CONTAINER=<service id> bash packages/database/scripts/schema-parity.sh
#
# pg_dump ALWAYS runs inside the Postgres container, never on the host. A client older than the
# server refuses with a version-mismatch error, and GitHub's ubuntu-latest ships one older than
# PG18. ci.yml already establishes this `docker exec <service id>` pattern for the redis config
# step.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-haive-postgres}"
PG_USER="${PG_USER:-haive}"
PG_PASSWORD="${PG_PASSWORD:-haive_dev_password}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PUSH_DB=parity_push_$$
MIG_DB=parity_migrate_$$

psql_admin() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q "$@"; }

cleanup_dbs() {
  psql_admin -c "DROP DATABASE IF EXISTS $PUSH_DB" -c "DROP DATABASE IF EXISTS $MIG_DB" >/dev/null 2>&1 || true
}
trap 'cleanup_dbs; rm -rf "$WORK"' EXIT

cleanup_dbs
psql_admin -c "CREATE DATABASE $PUSH_DB" -c "CREATE DATABASE $MIG_DB" >/dev/null

echo "[parity] building $PUSH_DB with drizzle-kit push --force"
DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$PUSH_DB" \
  pnpm --filter @haive/database push --force >"$WORK/push.log" 2>&1 ||
  { echo "[parity] push failed:"; tail -30 "$WORK/push.log"; exit 1; }

echo "[parity] building $MIG_DB with the migration runner"
DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$MIG_DB" \
  pnpm --filter @haive/database migrate >"$WORK/migrate.log" 2>&1 ||
  { echo "[parity] migrate failed:"; tail -30 "$WORK/migrate.log"; exit 1; }

# Two lines of dump noise, both unrelated to schema:
#   `-- Dumped from/by`  — server and client version banner.
#   `\restrict` / `\unrestrict` — MEASURED on PG18: pg_dump emits a fresh RANDOM token per dump,
#   so these differ on every run even for a byte-identical schema. Filtering them is required,
#   not cosmetic.
dump() {
  docker exec -i "$PG_CONTAINER" pg_dump -U "$PG_USER" --schema-only --no-owner \
    --no-privileges --no-comments --no-tablespaces --schema=public "$@" |
    grep -vE '^-- Dumped (from|by)|^\\(un)?restrict '
}

dump "$PUSH_DB" >"$WORK/push.sql"
# schema_migrations is excluded on the migration side ONLY, and deliberately: the runner's
# journal is intentionally absent from the Drizzle barrel (see src/migrate/journal.ts), so
# `push` never creates it and the two dumps would differ by exactly that table. Do not "fix"
# this asymmetry by adding the table to the barrel — push would then create a journal it can
# never write to, and the adoption classifier could not tell a runner-managed database from a
# pushed one.
dump --exclude-table=schema_migrations "$MIG_DB" >"$WORK/migrate.sql"

if diff -u "$WORK/push.sql" "$WORK/migrate.sql"; then
  echo "[parity] OK — the migration corpus and push --force produce the same schema ($(wc -l <"$WORK/push.sql") lines)"
else
  echo "[parity] FAIL — the diff above IS the report: left is push --force, right is the corpus."
  exit 1
fi
