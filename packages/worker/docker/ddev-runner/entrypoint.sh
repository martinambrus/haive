#!/bin/bash
# Start the nested Docker daemon (requires the container to run --privileged),
# wait for it, set up the ddev user's local CA, then hand off to CMD (sleep
# infinity). The worker drives `ddev` via `docker exec -u ddev <container> ...`.
set -e

# Route the nested dockerd's Docker Hub pulls through the shared pull-through cache
# when the worker provisioned one: it passes the fully-rendered daemon.json via
# DDEV_REGISTRY_DAEMON_JSON. Written verbatim before dockerd starts (the mirror name
# need not resolve yet — registry-mirrors is consulted lazily, per pull). Absent env
# => no daemon.json => dockerd pulls direct from Docker Hub (the pre-cache behavior).
if [ -n "$DDEV_REGISTRY_DAEMON_JSON" ]; then
  mkdir -p /etc/docker
  printf '%s' "$DDEV_REGISTRY_DAEMON_JSON" > /etc/docker/daemon.json
fi

dockerd >/var/log/dockerd.log 2>&1 &

for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  echo "nested dockerd failed to start" >&2
  tail -n 40 /var/log/dockerd.log >&2 || true
  exit 1
fi

# Local CA so DDEV's TLS works for the ddev user (best-effort; migrations don't
# need HTTPS, but ddev start sets up the router regardless).
sudo -u ddev CAROOT=/home/ddev/.local/share/mkcert mkcert -install >/dev/null 2>&1 || true

exec "$@"
