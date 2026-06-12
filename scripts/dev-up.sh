#!/usr/bin/env bash
# Start the dev stack, giving Ollama the host NVIDIA GPU when one is usable and
# falling back to CPU otherwise — Docker Compose cannot do this conditionally on
# its own (a failed nvidia device reservation hard-errors the service), so we
# detect here and layer in docker-compose.gpu.yml only when appropriate. Prints
# the chosen mode. Extra args pass through to `docker compose up` (e.g. service
# names), so `scripts/dev-up.sh ollama` recreates just Ollama in the right mode.
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(-f docker-compose.yml -f docker-compose.dev.yml)

if command -v nvidia-smi >/dev/null 2>&1 \
  && nvidia-smi -L >/dev/null 2>&1 \
  && docker info 2>/dev/null | grep -qiE 'runtimes:.*nvidia'; then
  echo "[dev-up] NVIDIA GPU detected -> Ollama will run on the GPU (fast embeddings)."
  FILES+=(-f docker-compose.gpu.yml)
else
  echo "[dev-up] No NVIDIA GPU available to Docker -> Ollama will run on CPU (embeddings slower)."
  echo "[dev-up] To enable GPU: install the NVIDIA Container Toolkit and ensure 'nvidia-smi' works."
fi

exec docker compose "${FILES[@]}" up -d "$@"
