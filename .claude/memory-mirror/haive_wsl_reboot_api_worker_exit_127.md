---
name: haive-wsl-reboot-api-worker-exit-127
description: After a WSL/Docker Desktop boot, haive-api and haive-worker stay Exited (127) on a docker.sock mount race and are not retried; prove the socket mounts, then `pnpm docker restart`
metadata:
  type: project
---

MEASURED 2026-09-15, WSL `up 1 min`: Docker Desktop auto-started the `unless-stopped` services.
web, postgres, redis, ollama and the proxies came up, but `haive-api` and `haive-worker` sat at
`Exited (127)` for the ~5 minutes until a manual restart. `docker inspect <c> --format
'{{.State.Error}}'` named the cause: `error mounting ".../docker-desktop-bind-mounts/Ubuntu-24.04/docker.sock"
to rootfs at "/var/run/docker.sock": ... not a directory`. The daemon started them before WSL's
socket proxy existed. That is an OCI create failure, and the restart policy did not retry it.
`haive-web` recovered on its own (`restarts=2`) because it mounts no socket.

Three things make it look healthier than it is. `docker ps` without `-a` simply omits the two dead
services. `docker logs` on them shows only the PREVIOUS run's lines, which read like a clean
shutdown. And 127 reads as "command not found", which is a red herring here.

**Why:** with the worker down nothing executes. Recreating it loses nothing, since it is already
dead; tasks parked `waiting_user` are unaffected.

**How to apply:** after any Windows/WSL/Docker Desktop restart, run
`docker ps -a --filter name=haive` and look for `Exited (127)`. Prove the socket mounts now:
`docker run --rm -v /var/run/docker.sock:/var/run/docker.sock redis:8.4-alpine sh -c 'test -S /var/run/docker.sock && echo OK'`.
Then run `pnpm docker restart`, which recovered both on 2026-09-15. Finish with the GPU proof in
[[haive-gpu-stack-restart]].
