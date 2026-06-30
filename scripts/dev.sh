#!/usr/bin/env bash
# Unified Haive dev-stack control. One entry point for the whole lifecycle
# (up/down/restart/logs/status/rebuild/reset) so nobody has to remember the
# compose -f overrides, the node_modules volume-recreation ritual, or the GPU
# layering. Run `scripts/dev.sh help` (or `pnpm docker help`) for the command list.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- compose wrapper ---------------------------------------------------------
# Always layer base + dev override. Add the GPU override only when an NVIDIA GPU
# is actually usable by Docker — a failed nvidia device reservation hard-errors
# the service, so compose cannot gate this on its own.
FILES=(-f docker-compose.yml -f docker-compose.dev.yml)
GPU_MODE="CPU"
if command -v nvidia-smi >/dev/null 2>&1 \
  && nvidia-smi -L >/dev/null 2>&1 \
  && docker info 2>/dev/null | grep -qiE 'runtimes:.*nvidia'; then
  FILES+=(-f docker-compose.gpu.yml)
  GPU_MODE="GPU"
fi
dc() { docker compose "${FILES[@]}" "$@"; }

say() { echo "[dev] $*"; }
gpu_note() {
  if [ "$GPU_MODE" = "GPU" ]; then
    say "NVIDIA GPU detected -> Ollama on GPU (fast embeddings)."
  else
    say "No NVIDIA GPU available to Docker -> Ollama on CPU (embeddings slower)."
  fi
}

# Build/cache volumes ONLY. The compose key is `haive_node_modules_*` and the
# project prefix is `haive`, so the real volume names carry the `haive_haive_`
# doubling (verified via `docker volume ls`) — do not "fix" it. Data volumes
# (postgres/redis/repos/…), the user's own ddev-* projects, the pull-through
# registry, and per-task runtimes are deliberately never named here, so rebuild
# and reset physically cannot touch them.
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
NM_VOLUMES=(
  "${PROJECT}_haive_node_modules_root"
  "${PROJECT}_haive_node_modules_shared"
  "${PROJECT}_haive_node_modules_database"
  "${PROJECT}_haive_node_modules_api"
  "${PROJECT}_haive_node_modules_worker"
  "${PROJECT}_haive_node_modules_web"
  "${PROJECT}_haive_web_next"
)
APP_SERVICES=(api worker web)

# Build @haive/database then @haive/shared (shared depends on database) in a
# single throwaway container — one writer for the shared dist, which is what
# prevents the parallel-tsc corruption when several services build it at once.
build_libs() {
  say "Building @haive/database + @haive/shared (single writer)..."
  dc run --rm dev-libs
}

rebuild_one() {
  local svc="$1" vols=()
  case "$svc" in
    api)    vols=("${PROJECT}_haive_node_modules_api") ;;
    worker) vols=("${PROJECT}_haive_node_modules_worker") ;;
    web)    vols=("${PROJECT}_haive_node_modules_web" "${PROJECT}_haive_web_next") ;;
    *) say "rebuild: unknown service '$svc' (expected api, worker, or web)"; exit 1 ;;
  esac
  say "Rebuilding $svc (package-local node_modules). For a root/shared/database dependency change use 'rebuild' with no args."
  dc rm -fs "$svc" || true
  docker volume rm "${vols[@]}" 2>/dev/null || true
  dc build "$svc"
  gpu_note
  dc up -d "$svc"
}

rebuild_all() {
  say "Full rebuild: recreating app images + node_modules volumes. Data volumes untouched."
  dc rm -fs dev-libs "${APP_SERVICES[@]}" || true
  docker volume rm "${NM_VOLUMES[@]}" 2>/dev/null || true
  dc build "${APP_SERVICES[@]}"
  gpu_note
  dc up -d
}

reset_stack() {
  say "Reset: full rebuild + wiping compiled dist/tsbuildinfo (stale/corrupt-build recovery). All data preserved."
  dc rm -fs dev-libs "${APP_SERVICES[@]}" || true
  docker volume rm "${NM_VOLUMES[@]}" 2>/dev/null || true
  dc build dev-libs "${APP_SERVICES[@]}"
  # Wipe the bind-mount compiled artifacts inside a container (host rm hits
  # EACCES on root-owned files); recreates the fresh volumes in the same pass.
  dc run --rm --no-deps --entrypoint sh dev-libs -c \
    "rm -rf packages/shared/dist packages/database/dist packages/shared/*.tsbuildinfo packages/database/*.tsbuildinfo"
  gpu_note
  dc up -d
}

usage() {
  cat <<'EOF'
Haive dev stack — one tool for the whole lifecycle.

  pnpm docker <cmd>            (or: bash scripts/dev.sh <cmd>)

Commands:
  up [svc...]        Start the stack (GPU-aware). Alias: run
  down               Stop the stack. Keeps all data (never -v).
  restart [svc...]   Rebuild libs once, then recreate service(s). Default: whole stack.
  logs [svc...]      Follow logs.
  status             Show service status. Alias: ps
  libs               Rebuild @haive/shared + @haive/database after editing their source.
  rebuild [svc...]   Pick up a dependency/lockfile change: rebuild image(s) + recreate
                     node_modules volumes. No args = full rebuild; a root/shared/database
                     dependency needs the full rebuild (those node_modules are shared).
  reset              Full rebuild + wipe compiled dist (recover a stale/corrupt build).
  sandbox-build      Build the cli-sandbox image.
  migrate            Push the DB schema (drizzle-kit push --force).
  help               This text.

rebuild/reset only ever touch the node_modules and .next caches — data volumes
(postgres/redis/repos/…), your own ddev-* projects, and per-task runtimes are
never touched. Never run `down -v` or `docker volume prune` against this stack.
EOF
}

# --- dispatch ----------------------------------------------------------------
cmd="${1:-help}"
shift || true
case "$cmd" in
  up|run)        gpu_note; dc up -d "$@" ;;
  down)          dc down ;;
  logs)          dc logs -f "$@" ;;
  status|ps)     dc ps ;;
  libs)          build_libs ;;
  restart)       dc rm -fs dev-libs >/dev/null 2>&1 || true; gpu_note; dc up -d --force-recreate "$@" ;;
  rebuild)       if [ "$#" -eq 0 ]; then rebuild_all; else for s in "$@"; do rebuild_one "$s"; done; fi ;;
  reset)         reset_stack ;;
  sandbox-build) dc --profile sandbox build cli-sandbox ;;
  migrate)       dc run --rm db-migrate ;;
  help|-h|--help) usage ;;
  *)             say "unknown command: $cmd"; echo; usage; exit 1 ;;
esac
