#!/usr/bin/env bash
# Runs prompt-step-smoke.ts on its own postgres and redis, both on ephemeral loopback ports and
# both removed on exit. Usage: prompt-step-smoke.sh <evidence-file> [entry|resolvable]
set -uo pipefail

evidence="${1:?evidence file}"
control="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
pg="haive-prompt-step-pg-${suffix}"
rd="haive-prompt-step-redis-${suffix}"

cleanup() {
  docker rm -f "$pg" "$rd" >/dev/null 2>&1
}
trap cleanup EXIT

mkdir -p "$(dirname "$evidence")"
docker run -d --name "$pg" -p 127.0.0.1::5432 -e POSTGRES_USER=haive -e POSTGRES_PASSWORD=haive_smoke \
  -e POSTGRES_DB=haive postgres:18 >/dev/null || exit 2
docker run -d --name "$rd" -p 127.0.0.1::6379 redis:8 redis-server --maxmemory-policy noeviction >/dev/null || exit 2

for _ in $(seq 1 60); do
  docker exec "$pg" pg_isready -U haive -d haive >/dev/null 2>&1 && docker exec "$rd" redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done

pg_port="$(docker port "$pg" 5432/tcp | head -n1 | sed 's/.*://')"
rd_port="$(docker port "$rd" 6379/tcp | head -n1 | sed 's/.*://')"
export DATABASE_URL="postgres://haive:haive_smoke@127.0.0.1:${pg_port}/haive"
export REDIS_URL="redis://127.0.0.1:${rd_port}"
export CONFIG_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export JWT_SECRET="prompt-step-smoke-jwt-secret-not-real-padding-padding"
export NODE_ENV=test
export HAIVE_TEST_BYPASS_LLM=1
export EVIDENCE_FILE="$evidence"
export NEGATIVE_CONTROL="$control"

cd "$root" || exit 2
pnpm --filter @haive/database migrate >/dev/null || exit 2
pnpm --filter @haive/worker exec tsx test/prompt-step-smoke.ts
