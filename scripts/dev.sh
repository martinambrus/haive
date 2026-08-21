#!/usr/bin/env bash
# Unified Haive dev-stack control. One entry point for the whole lifecycle
# (up/down/restart/logs/status/rebuild/reset) so nobody has to remember the
# compose -f overrides, the node_modules volume-recreation ritual, or the GPU
# layering. Run `scripts/dev.sh help` (or `pnpm docker help`) for the command list.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- compose wrapper ---------------------------------------------------------
# Always layer base + dev override. Add a GPU override when hardware is usable:
#   1. NVIDIA dGPU  — requires nvidia-smi + nvidia container runtime
#   2. Vulkan iGPU  — Intel Iris Xe / Arc or AMD with /dev/dri render nodes
#   3. CPU fallback — no extra file, Ollama runs on CPU
# A failed nvidia device reservation hard-errors the service, so compose cannot
# gate NVIDIA on its own. Vulkan is safe to layer unconditionally when render
# nodes exist — Ollama simply falls back to CPU if Vulkan init fails at runtime.
#
# Set HAIVE_GPU=cpu to take the CPU path deliberately on a GPU host (skips both
# probes and the guard below).

say() { echo "[dev] $*"; }

# Does the daemon expose the `nvidia` runtime? Asks the documented --format
# template for the runtime NAMES and matches one exactly. The previous check
# grepped `docker info`'s human-readable banner for `runtimes:.*nvidia`; that
# banner is display copy whose layout is not a contract, and a reworded or
# re-ordered line would read as "no GPU" while everything still worked.
#
# Retried because this is not only a capability question: `docker info` talks to
# a daemon that is usually busy starting ~10 containers when dev.sh runs, and one
# slow call used to be indistinguishable from "no nvidia runtime" (observed
# 2026-07-27, and again 2026-08-10 where a rebuild booted ollama with
# HostConfig.Runtime=runc while nvidia-smi and the runtime list both passed
# moments later).
has_nvidia_runtime() {
  local i
  for i in 1 2 3; do
    if docker info --format '{{range $k, $v := .Runtimes}}{{println $k}}{{end}}' 2>/dev/null |
      grep -qx nvidia; then
      return 0
    fi
    if [ "$i" -lt 3 ]; then sleep 1; fi
  done
  return 1
}

FILES=(-f docker-compose.yml -f docker-compose.dev.yml)
GPU_MODE="CPU"
GPU_DEGRADED=0
if [ "${HAIVE_GPU:-auto}" = "cpu" ]; then
  GPU_MODE="CPU-forced"
elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  # A card IS present. From here CPU must never be a SILENT outcome: recreating
  # ollama without the GPU override looks identical to a healthy boot and only
  # surfaces later as very slow embeddings. Record the degrade; gpu_guard turns
  # it into a hard stop for the commands that can actually recreate ollama.
  if has_nvidia_runtime; then
    FILES+=(-f docker-compose.gpu.yml)
    GPU_MODE="NVIDIA"
  else
    GPU_DEGRADED=1
  fi
elif [ -e /dev/dri/renderD128 ]; then
  FILES+=(-f docker-compose.vulkan.yml)
  GPU_MODE="Vulkan"
fi
dc() { docker compose "${FILES[@]}" "$@"; }

gpu_note() {
  case "$GPU_MODE" in
    NVIDIA)     say "NVIDIA GPU detected -> Ollama on GPU (fast embeddings)." ;;
    Vulkan)     say "Vulkan GPU detected (Intel/AMD) -> Ollama on iGPU via Vulkan (moderate speed)." ;;
    CPU-forced) say "HAIVE_GPU=cpu -> GPU probes skipped, Ollama on CPU (embeddings slower)." ;;
    *)          say "No GPU available to Docker -> Ollama on CPU (embeddings slower)." ;;
  esac
}

# Called ONLY by the commands that (re)create containers — up/restart/rebuild/reset.
# down/logs/status/libs/migrate/help never touch ollama, so they stay usable on a
# host whose NVIDIA runtime is broken. Called BEFORE any teardown so a refusal
# cannot leave a service stopped.
gpu_guard() {
  [ "$GPU_DEGRADED" -eq 1 ] || return 0
  say "REFUSING TO START: nvidia-smi sees a GPU, but the docker daemon did not"
  say "list an 'nvidia' runtime across 3 probes."
  say "Booting now would recreate ollama on CPU and look completely normal."
  say "Fix the NVIDIA Container Toolkit (or restart Docker Desktop / WSL), then"
  say "re-run. To accept CPU on purpose: HAIVE_GPU=cpu $0 $*"
  exit 1
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
  # Build dev-libs too: it starts first (the depends_on gate) and mounts the shared
  # root node_modules volume, so a stale dev-libs image repopulates root with OLD
  # deps even though api/worker/web were rebuilt. Keep its image in lockstep.
  dc build dev-libs "${APP_SERVICES[@]}"
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

HAIVE_GPU=cpu <cmd>  Skip the GPU probes and boot Ollama on CPU on purpose.

rebuild/reset only ever touch the node_modules and .next caches — data volumes
(postgres/redis/repos/…), your own ddev-* projects, and per-task runtimes are
never touched. Never run `down -v` or `docker volume prune` against this stack.
EOF
}

# --- dispatch ----------------------------------------------------------------
cmd="${1:-help}"
shift || true
case "$cmd" in
  up|run)        gpu_guard "$cmd"; gpu_note; dc up -d "$@" ;;
  down)          dc down ;;
  logs)          dc logs -f "$@" ;;
  status|ps)     dc ps ;;
  libs)          build_libs ;;
  restart)       gpu_guard "$cmd"; dc rm -fs dev-libs >/dev/null 2>&1 || true; gpu_note; dc up -d --force-recreate "$@" ;;
  rebuild)       gpu_guard "$cmd"; if [ "$#" -eq 0 ]; then rebuild_all; else for s in "$@"; do rebuild_one "$s"; done; fi ;;
  reset)         gpu_guard "$cmd"; reset_stack ;;
  sandbox-build) dc --profile sandbox build cli-sandbox ;;
  migrate)       dc run --rm db-migrate ;;
  help|-h|--help) usage ;;
  *)             say "unknown command: $cmd"; echo; usage; exit 1 ;;
esac
