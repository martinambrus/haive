---
name: haive-gpu-stack-restart
description: How to restart the Haive stack with GPU and prove Ollama actually landed on the GPU
metadata:
  node_type: memory
  type: project
  originSessionId: 77d92749-e3c7-4fa7-994c-1a80fed4b544
  modified: 2026-10-03T11:43:21.015Z
---

`bash scripts/dev.sh restart` (or `pnpm docker restart`) is the GPU-aware restart; it
layers `docker-compose.gpu.yml` when `nvidia-smi` works AND the daemon lists an `nvidia`
runtime, and `gpu_guard` hard-refuses rather than booting Ollama on CPU silently.

**Why:** the override only sets `runtime: nvidia` + `HAIVE_GPU_EXPECTED=1`; neither flag
proves inference is on the card, and a driver/runtime mismatch passes both checks.

**How to apply:** verify in this order —

1. `docker inspect haive-ollama --format '{{.HostConfig.Runtime}}'` → `nvidia`, and the worker's
   env carries `HAIVE_GPU_EXPECTED=1`. These prove the override was layered, which the
   `[dev] NVIDIA GPU detected` banner cannot: it is the FIRST line of a long compose log, so
   `| tail` drops it.
2. `/usr/bin/docker logs haive-ollama 2>&1 | grep "inference compute"` → `library=CUDA ... RTX 3050`.
   The absolute path is required, not style: [[rtk-docker-logs-summarized]].
3. load a CHAT model (embed models get unloaded immediately by the worker's residency
   manager, so `ollama ps` is empty for them) and read placement:
   `docker exec haive-worker node -e 'fetch("http://ollama:11434/api/generate",{method:"POST",body:JSON.stringify({model:"qwen3:1.7b",prompt:"hi",stream:false,keep_alive:"90s"})})'`
   then either `docker exec haive-ollama ollama ps` → `100% GPU`, or the structured form:
   `docker exec haive-worker node -e 'fetch("http://ollama:11434/api/ps").then(r=>r.json()).then(j=>{for(const m of j.models){console.log(m.name,"size="+m.size,"size_vram="+m.size_vram,"fullyOnGpu="+(m.size_vram===m.size))}})'`
   → `fullyOnGpu=true` (MEASURED 2026-09-15: `size=1702593821 size_vram=1702593821`; the `blank`
   install on 2026-10-03 gave the identical numbers).
   `qwen3-embedding:4b` will NOT read `fullyOnGpu=true`: MEASURED 2026-10-03, loaded alone it was
   `size=4756498019 size_vram=4297945251` (90%/10% GPU/CPU). VRAM was 1120 MiB used and 4883 MiB free of
   6144 MiB with every Haive model unloaded (a host `ollama serve` runs; the holder is not attributed), against a
   4536 MiB model plus its 4096-token KV cache. Judge the GPU proof on the chat model, not the embed model.
   Do not probe from the host: [[haive-host-ollama-shadows-container-port]].
   After a WSL reboot this restart is also what revives api/worker: [[haive-wsl-reboot-api-worker-exit-127]].
