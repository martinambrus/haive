---
name: haive-host-ollama-shadows-container-port
description: A host ollama serve on 127.0.0.1:11434 shadows haive-ollama's published port, so host curl to localhost:11434 never reaches the stack
metadata:
  type: project
---

This WSL host runs its own `/usr/local/bin/ollama serve` bound to `127.0.0.1:11434`,
while `haive-ollama` publishes `0.0.0.0:11434`. A host-side `curl http://localhost:11434/...`
resolves to 127.0.0.1 and hits the HOST daemon — the request never appears in
`docker logs haive-ollama`, and its timings say nothing about the container's GPU.

**Why:** measured 2026-09-06 — two `/api/embed` calls to `localhost:11434` returned in
8.4s / 471ms with zero matching GIN lines in the container log, and `pgrep -a ollama`
plus `ss -ltnp` showed the host listener. Both daemons also contend for the same 6 GiB
RTX 3050.

**How to apply:** to exercise the stack's ollama, go through a container —
`docker exec haive-worker node -e 'fetch("http://ollama:11434/...")'` — then read
placement with `docker exec haive-ollama ollama ps` (`PROCESSOR` column). See
[[haive-gpu-stack-restart]].
