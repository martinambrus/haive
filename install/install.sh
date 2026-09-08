#!/bin/sh
#
# Haive one-line installer (RUN-IT).
#
#   curl -fsSL https://raw.githubusercontent.com/martinambrus/haive/main/install/install.sh | sh
#
# Installs a PUBLISHED release: fetches a versioned compose bundle, generates this install's own
# secrets, pulls images and boots the stack. It builds nothing and clones nothing — a contributor
# wanting to build from source wants `pnpm docker:dev` instead, which this script never touches.
#
# POSIX sh on purpose: the documented line pipes into `sh`, so bashisms would break exactly the
# invocation the docs give. No arrays, no [[ ]], no pipefail.
#
# Read-then-run is supported and encouraged: download this file, read it, run it.

set -eu

REPO="${HAIVE_REPO:-martinambrus/haive}"
REGISTRY_DEFAULT="ghcr.io/martinambrus"
RAW="https://raw.githubusercontent.com/${REPO}"
RELEASES="https://github.com/${REPO}/releases/download"
API="https://api.github.com/repos/${REPO}"

VERSION=""
INSTALL_DIR=""
INSTALL_ID=""
CHANNEL="public"
CHECK_ONLY=0
FORCE=0
NO_START=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
# Every failure names the fix. A stack trace tells the user nothing they can act on.
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Haive installer

  install.sh [options]

  --version <v>   Install this release (e.g. 0.1.4, or 'latest' / 'next'). An alias is
                  resolved to a concrete version and PINNED, so the install cannot drift
                  onto a moving tag. Default: latest.
  --dir <path>    Install directory. Default: \$HOME/haive
  --install-id    Names every container, volume, network and database this install owns
                  ([a-z0-9_], default 'haive'). Give a SECOND install on this machine its
                  own id, or it shares the first one's repositories and RAG data. It
                  identifies the install, never the version, and changing it later orphans
                  what the install owns rather than renaming it — so choose it now.
  --channel <id>  Release channel. Default: public
  --check         Run the preflight checks and exit, changing nothing.
  --force         Install into a non-empty directory.
  --no-start      Write the install but do not boot the stack.
  -h, --help      This text.

The installer never upgrades an existing install: re-running it against one is refused.
Use the Upgrade page in the admin console, or ./haive upgrade in the install directory.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; [ -n "$VERSION" ] || die "--version needs a value"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; [ -n "$INSTALL_DIR" ] || die "--dir needs a value"; shift 2 ;;
    --install-id) INSTALL_ID="${2:-}"; [ -n "$INSTALL_ID" ] || die "--install-id needs a value"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; [ -n "$CHANNEL" ] || die "--channel needs a value"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    --force)   FORCE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
# Prerequisites are CHECKED, never installed. Docker is privileged, OS-specific, and on
# macOS/Windows it is Docker Desktop, whose licence nobody can accept on the user's behalf.
# A `curl | sh` that also installed a root-equivalent daemon would be a far larger trust ask
# than one that boots containers.

need_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say ""
  say "Missing: $1"
  say "  $2"
  return 1
}

docker_install_hint() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) say "  Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/" ;;
    Linux)  say "  Install Docker Engine:  https://get.docker.com" ;;
    *)      say "  Install Docker Desktop: https://docs.docker.com/desktop/" ;;
  esac
}

preflight() {
  step "Checking prerequisites"
  ok=1

  if ! command -v docker >/dev/null 2>&1; then
    say "Missing: docker"; docker_install_hint; ok=0
  else
    say "  docker            found"
  fi

  if [ "$ok" -eq 1 ]; then
    if ! docker info >/dev/null 2>&1; then
      say "Missing: a reachable Docker daemon"
      say "  Docker is installed but not answering. Start Docker Desktop, or:"
      say "    sudo systemctl start docker"
      say "  If you are not in the 'docker' group, add yourself and log out and back in:"
      say "    sudo usermod -aG docker \$USER"
      ok=0
    else
      say "  docker daemon     reachable"
    fi
  fi

  if [ "$ok" -eq 1 ]; then
    if ! docker compose version >/dev/null 2>&1; then
      say "Missing: Docker Compose v2"
      say "  'docker compose' (with a space) is required; the old 'docker-compose' will not do."
      docker_install_hint
      ok=0
    else
      say "  docker compose    $(docker compose version --short 2>/dev/null || echo v2)"
    fi
  fi

  need_cmd curl "Install curl with your package manager (apt install curl / brew install curl)." || ok=0

  # The master KEK must be RANDOM. No fallback to anything predictable exists, so the absence of
  # every source of randomness is a hard stop rather than a degradation.
  if command -v openssl >/dev/null 2>&1; then
    say "  openssl           found"
  elif [ -r /dev/urandom ]; then
    say "  openssl           absent, using /dev/urandom"
  else
    say "Missing: a source of randomness (openssl or /dev/urandom)"
    say "  Haive generates this install's own encryption key and refuses to use a predictable one."
    ok=0
  fi

  # Advisory, never blocking: a small machine can still run Haive, just fewer agents at once.
  if [ -r /proc/meminfo ]; then
    kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    gb=$(( kb / 1024 / 1024 ))
    if [ "$gb" -gt 0 ]; then
      if [ "$gb" -lt 8 ]; then
        warn "this machine has ${gb} GB RAM. Haive budgets agents and runtimes against roughly 70% of
         it, so expect one agent at a time. 16 GB or more is comfortable."
      else
        say "  memory            ${gb} GB"
      fi
    fi
  fi

  [ "$ok" -eq 1 ] || die "prerequisites are missing (see above). Nothing was changed."
  say ""
  say "Ready to install."
}

# ── Version resolution ───────────────────────────────────────────────────────
# An alias is resolved to a concrete version BEFORE anything is written. An install left pointing
# at a moving tag changes underneath its owner on the next `docker compose up` — an unrequested
# upgrade with no migration gate, no snapshot and no health check.

resolve_version() {
  want="${1:-latest}"
  case "$want" in
    ""|latest)
      tag=$(curl -fsSL "${API}/releases/latest" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      [ -n "$tag" ] || die "could not resolve the latest release from GitHub. Check your network, or pass --version <v>."
      ;;
    next)
      # Newest release including prereleases. The API lists newest-first.
      tag=$(curl -fsSL "${API}/releases?per_page=1" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      [ -n "$tag" ] || die "could not resolve a prerelease from GitHub. Check your network, or pass --version <v>."
      ;;
    *)
      case "$want" in v*) tag="$want" ;; *) tag="v${want}" ;; esac
      ;;
  esac
  printf '%s' "$tag"
}

# ── Install ──────────────────────────────────────────────────────────────────

# ── Host ports ───────────────────────────────────────────────────────────────
# Probed, not assumed. The defaults collide in practice rather than in theory: Haive pins
# DDEV's global mailpit to 8025-8026, so any machine that has ever run a Haive-managed DDEV
# project already holds this installer's default mailpit port — MEASURED, `ddev-router`
# publishing 127.0.0.1:8025-8026. A second Haive install collides on all three.
#
# `ss` sees every listener, including non-docker ones, and is the authority where present.
# Docker's own published-port list is the fallback, because the collisions that actually
# happen here are with other containers. Neither present means no probe: compose then reports
# the bind failure itself, which is a worse message but not a wrong outcome.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$" && return 0
    return 1
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(^|[^0-9])$1->" && return 0
  fi
  return 1
}

# First free port at or after $1. Bounded so a pathological host fails loudly instead of looping.
free_port() {
  p=$1
  n=0
  while [ "$n" -lt 50 ]; do
    port_in_use "$p" || { printf '%s' "$p"; return 0; }
    p=$((p + 1))
    n=$((n + 1))
  done
  die "could not find a free port at or after $1 after 50 tries. Free one, or pass the port explicitly in .env after installing with --no-start."
}

rand_hex() {
  # $1 = bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'
  fi
}

fetch() {
  # $1 = url, $2 = dest
  curl -fsSL "$1" -o "$2" || die "could not download $1"
}

# Validated here rather than at first use: it names Docker volumes and Postgres databases, and
# compose builds both `<id>-api` and `<id>_repos` from it without being able to convert between
# the conventions — so a `-` inside it would leave the two halves of one install disagreeing.
: "${INSTALL_ID:=haive}"
case "$INSTALL_ID" in
  *[!a-z0-9_]*|[!a-z0-9]*|"") die "--install-id must be [a-z0-9_] starting with a letter or digit, and was '$INSTALL_ID'." ;;
esac

# An install id that already owns state on this machine is refused, and this is the guard that
# matters most. Postgres applies POSTGRES_PASSWORD only when it INITIALISES an empty data
# directory, so pointing a fresh install at an existing volume does not re-key it — MEASURED, the
# install failed with `password authentication failed for user "haive"` after silently adopting a
# `haive_postgres_data` created months earlier by a dev stack. The failure is the lucky outcome:
# had the passwords matched, a "fresh install" would have come up on someone else's live database
# with their tasks, repositories and secrets in it, and said nothing.
existing_state() {
  docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${INSTALL_ID}_postgres_data" && return 0
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${INSTALL_ID}-api" && return 0
  return 1
}
if existing_state; then
  die "an install named '${INSTALL_ID}' already has data on this machine.
       Its Postgres volume (${INSTALL_ID}_postgres_data) or containers are still here, and a new
       install would come up on that existing database rather than a fresh one.
         - to run a SECOND Haive alongside it:   --install-id <another-name>
         - to reinstall this one from scratch:   remove its volumes first (see its uninstall script)
         - to keep it and upgrade instead:       use the admin console's Maintenance page"
fi

preflight
[ "$CHECK_ONLY" -eq 0 ] || { say ""; say "--check: nothing was installed."; exit 0; }

[ "$CHANNEL" = "public" ] || die "channel '$CHANNEL' is not available yet. Only the public channel is published today."

step "Resolving the release"
TAG=$(resolve_version "$VERSION")
PINNED="${TAG#v}"
say "  requested         ${VERSION:-latest}"
say "  resolved          ${PINNED}  (tag ${TAG})"

# Verify the release EXISTS before generating a secret or pulling an image, so a typo costs
# nothing. Its manifest is the artefact an upgrade reads too.
MANIFEST_URL="${RELEASES}/${TAG}/release.json"
curl -fsSL -o /dev/null "$MANIFEST_URL" 2>/dev/null \
  || die "release ${TAG} has no published manifest at ${MANIFEST_URL}.
       Check the version, or list what exists: https://github.com/${REPO}/releases"
say "  manifest          found"

: "${INSTALL_DIR:=${HOME:-.}/${INSTALL_ID}}"
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;; esac

if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  if [ -f "$INSTALL_DIR/.env" ]; then
    die "$INSTALL_DIR already holds a Haive install.
       The installer never upgrades: running an install command is not consent to migrate a live
       database, and none of the drain, snapshot or health-gate steps that make an upgrade safe
       happen here. Upgrade from the admin console's Maintenance page, or:
         cd $INSTALL_DIR && ./haive upgrade --version <v>"
  fi
  [ "$FORCE" -eq 1 ] || die "$INSTALL_DIR is not empty. Pass --force to install into it anyway."
fi

step "Writing the install to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/snapshots"
cd "$INSTALL_DIR"

# The compose bundle is fetched AT THE TAG, so it always matches the images being pinned.
fetch "${RAW}/${TAG}/docker-compose.yml"     docker-compose.yml
fetch "${RAW}/${TAG}/docker-compose.run.yml" docker-compose.run.yml
say "  compose bundle    docker-compose.yml + docker-compose.run.yml"

# GPU layering, mirroring scripts/dev.sh so a RUN-IT host makes the same choice a dev host does.
GPU_MODE="CPU"
GPU_FILE=""
has_nvidia_runtime() {
  i=1
  while [ "$i" -le 3 ]; do
    if docker info --format '{{range $k, $v := .Runtimes}}{{println $k}}{{end}}' 2>/dev/null | grep -qx nvidia; then
      return 0
    fi
    [ "$i" -lt 3 ] && sleep 1
    i=$((i + 1))
  done
  return 1
}
if [ "${HAIVE_GPU:-auto}" = "cpu" ]; then
  GPU_MODE="CPU (forced)"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 && has_nvidia_runtime; then
  fetch "${RAW}/${TAG}/docker-compose.gpu.yml" docker-compose.gpu.yml
  GPU_FILE="docker-compose.gpu.yml"; GPU_MODE="NVIDIA"
elif [ -e /dev/dri/renderD128 ]; then
  fetch "${RAW}/${TAG}/docker-compose.vulkan.yml" docker-compose.vulkan.yml
  GPU_FILE="docker-compose.vulkan.yml"; GPU_MODE="Vulkan (Intel/AMD)"
fi
say "  ollama            ${GPU_MODE}"

WEB_PORT=$(free_port 3000)
API_PORT=$(free_port "$((WEB_PORT + 1))")
MAILPIT_PORT=$(free_port 8025)
say "  ports             web ${WEB_PORT}, api ${API_PORT}, mail ${MAILPIT_PORT}"

# Secrets. Generated per install and stored only here — a shipped default would mean every install
# shared one encryption key and any user could decrypt any other's secrets.
if [ ! -f .env ]; then
  KEY=$(rand_hex 32)
  JWT=$(rand_hex 32)
  PGPW=$(rand_hex 16)
  [ -n "$KEY" ] && [ -n "$JWT" ] && [ -n "$PGPW" ] || die "could not generate secrets. Nothing was installed."
  umask 077
  cat > .env <<EOF
# Haive install — generated $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Keep this file. CONFIG_ENCRYPTION_KEY is the master key for every secret this install stores;
# lose it and stored credentials cannot be decrypted.

HAIVE_VERSION=${PINNED}
HAIVE_REGISTRY=${REGISTRY_DEFAULT}

# Names every container, volume, network and database this install owns. Two installs on one
# machine need two ids, or the second silently mounts the first one's cloned repositories.
# It identifies the INSTALL, never the version — the version lives in HAIVE_VERSION above.
HAIVE_INSTALL_ID=${INSTALL_ID}
COMPOSE_PROJECT_NAME=${INSTALL_ID}

CONFIG_ENCRYPTION_KEY=${KEY}
JWT_SECRET=${JWT}
POSTGRES_PASSWORD=${PGPW}

# Ports on the host. Change these if something already holds them.
HAIVE_WEB_PORT=${WEB_PORT}
HAIVE_API_PORT=${API_PORT}
HAIVE_MAILPIT_PORT=${MAILPIT_PORT}

# Read-only view of your filesystem, used to import a repository that already exists on disk.
# Written explicitly rather than defaulted: compose expands \${HOME}, which PowerShell does not
# set, and the mount then fails with "empty section between colons".
HOST_REPO_ROOT=${HOME:-/}

# Where this install lives, as the DOCKER DAEMON sees it. The api hands this to \`docker run -v\`
# when it launches the updater, and the daemon resolves it on the host — nothing inside a
# container can work it out. Without it the in-app Upgrade button is not offered.
HAIVE_INSTALL_DIR_HOST=${INSTALL_DIR}
EOF
  chmod 600 .env
  say "  secrets           generated (.env, mode 600)"
fi

# ── Helper scripts ───────────────────────────────────────────────────────────

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.run.yml"
[ -n "$GPU_FILE" ] && COMPOSE_FILES="$COMPOSE_FILES -f $GPU_FILE"

cat > haive <<EOF
#!/bin/sh
# Haive control script for this install. Generated by the installer.
set -eu
cd "\$(dirname "\$0")"
DC="docker compose ${COMPOSE_FILES}"
case "\${1:-}" in
  up)      shift; \$DC up -d "\$@" ;;
  down)    shift; \$DC down "\$@" ;;
  logs)    shift; \$DC logs -f "\$@" ;;
  ps)      shift; \$DC ps "\$@" ;;
  version) curl -fsS http://localhost:\${HAIVE_API_PORT:-3001}/version; echo ;;
  upgrade)
    shift
    v=""
    while [ \$# -gt 0 ]; do case "\$1" in --version) v="\${2:-}"; shift 2 ;; *) break ;; esac; done
    [ -n "\$v" ] || { echo "usage: ./haive upgrade --version <v> [--force]" >&2; exit 2; }
    # The updater runs OUTSIDE this compose project: a process cannot bring itself down and
    # survive to verify the result or roll it back.
    . ./.env
    exec docker run --rm -it \\
      --network "\${HAIVE_NETWORK:-\${HAIVE_INSTALL_ID:-haive}-network}" \\
      -v /var/run/docker.sock:/var/run/docker.sock \\
      -v "\${HAIVE_INSTALL_DIR_HOST}:/install" \\
      -e COMPOSE_PROJECT_NAME="\${COMPOSE_PROJECT_NAME:-\${HAIVE_INSTALL_ID:-haive}}" \\
      -e HAIVE_INSTALL_ID="\${HAIVE_INSTALL_ID:-haive}" \\
      -e DATABASE_URL="postgres://\${POSTGRES_USER:-haive}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-haive}" \\
      -e REDIS_URL="redis://redis:6379" \\
      -e CONFIG_ENCRYPTION_KEY="\${CONFIG_ENCRYPTION_KEY}" \\
      "\${HAIVE_REGISTRY}/haive-updater:\${v#v}" \\
      --manifest "https://github.com/${REPO}/releases/download/v\${v#v}/release.json" \\
      --install-dir /install \\
      --registry "\${HAIVE_REGISTRY}" \\
      --postgres-volume "\${COMPOSE_PROJECT_NAME:-\${HAIVE_INSTALL_ID:-haive}}_postgres_data" \\
      --snapshot-host-dir "\${HAIVE_INSTALL_DIR_HOST}/snapshots" "\$@"
    ;;
  *) echo "usage: ./haive up|down|logs|ps|version|upgrade --version <v>" >&2; exit 2 ;;
esac
EOF
chmod +x haive

# Uninstall deliberately does NOT use `down -v`. Five volumes in docker-compose.yml carry an
# explicit global `name:` — haive_repos, haive_bundles, haive_wrappers, haive_squid_configs,
# haive_ddev_ca — so they are shared with any other Haive on this machine, and `-v` would take
# another install's cloned repositories with it. Only this project's own volumes are removed,
# and the shared ones are named so the choice is the operator's.
cat > uninstall.sh <<'EOF'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
DC="docker compose -f docker-compose.yml -f docker-compose.run.yml"
PROJECT="$(. ./.env 2>/dev/null && printf '%s' "${COMPOSE_PROJECT_NAME:-haive}")"

echo "Removing the Haive stack and THIS install's data volumes."
echo "Project: $PROJECT"
printf 'Type the project name to confirm: '
read -r reply
[ "$reply" = "$PROJECT" ] || { echo "aborted."; exit 1; }

$DC down || true
for v in postgres_data redis_data mailpit_data ollama_data; do
  docker volume rm "${PROJECT}_${v}" >/dev/null 2>&1 && echo "  removed ${PROJECT}_${v}" || true
done

cat <<'NOTE'

These volumes are NOT removed, because they are named globally and shared with any
other Haive install on this machine:

  haive_repos  haive_bundles  haive_wrappers  haive_squid_configs  haive_ddev_ca
  haive_npm_cache  haive_ddev_registry_cache

haive_repos holds your cloned repositories. If this was the only install, remove them with:

  docker volume rm haive_repos haive_bundles haive_wrappers haive_squid_configs haive_ddev_ca

Then delete this directory.
NOTE
EOF
chmod +x uninstall.sh
say "  helpers           ./haive, ./uninstall.sh"

if [ "$NO_START" -eq 1 ]; then
  say ""
  say "--no-start: written but not booted. Start it with:  cd $INSTALL_DIR && ./haive up"
  exit 0
fi

step "Pulling images (this is the slow part)"
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES pull --quiet 2>&1 | grep -vi 'pulling\|pulled\|waiting' || true

step "Starting Haive"
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up -d

step "Waiting for the API"
PORT=$(sed -n 's/^HAIVE_API_PORT=//p' .env | head -1); : "${PORT:=3001}"
i=1
while [ "$i" -le 120 ]; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    say "  api               healthy"
    break
  fi
  [ "$i" -lt 120 ] || die "the API never became healthy. Look at the logs:  cd $INSTALL_DIR && ./haive logs api"
  sleep 2
  i=$((i + 1))
done

WEB=$(sed -n 's/^HAIVE_WEB_PORT=//p' .env | head -1); : "${WEB:=3000}"
cat <<EOF

  Haive ${PINNED} is running.

    Web       http://localhost:${WEB}
    API       http://localhost:${PORT}
    Mail      http://localhost:$(sed -n 's/^HAIVE_MAILPIT_PORT=//p' .env | head -1)
    Directory ${INSTALL_DIR}
    Install   ${INSTALL_ID}

  Manage it with ./haive up|down|logs|ps|version|upgrade, and remove it with ./uninstall.sh.

  One thing you should know before you use it:

    The Haive worker mounts the Docker socket, so it can create and destroy containers on
    this machine. That is how it runs AI CLIs in sandboxes — and it is equivalent to root
    on the host. Run Haive on a machine where that is acceptable. Rootless Docker is the
    alternative and is documented in the README.

EOF
