#!/usr/bin/env bash
# Runs a registry-fetching command up to three times. It retries on the exit status alone, never
# on the error text, which Docker is free to reword.
set -u

attempts=3
for attempt in $(seq 1 "$attempts"); do
  "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    exit "$status"
  fi
  delay=$((attempt * 20))
  echo "ci-retry: attempt ${attempt}/${attempts} failed (exit ${status}): $*; retrying in ${delay}s" >&2
  sleep "$delay"
done
