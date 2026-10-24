---
name: throwaway-container-ephemeral-port
description: 'Publish a throwaway test container on a Docker-assigned port; a fixed port may belong to h1-smoke-* and a failed `docker run` still lets the test hit it'
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3f0c544-0081-42eb-b0d8-fc58d423baba
  modified: 2026-10-11T08:58:56.932Z
---

Start a throwaway Redis/Postgres for a test with `-p 127.0.0.1::<containerPort>` and read the real port back with `docker port <name> <port>/tcp`. Never pick a fixed host port such as 6391 or 6392.

**Why:** on 2026-10-11, `docker run -p 127.0.0.1:6392:6379` failed with "port is already allocated", but the next command in the chain still ran the real-Redis test against 6392. That port was `h1-smoke-redis`, a container the user forbids touching. The test only wrote and deleted its own key, so no harm was done, but it was a boundary breach.

**How to apply:**

- Chain the container start and the test with `&&`, so a failed start stops everything after it.
- Check `docker ps --format '{{.Names}} {{.Ports}}'` before reusing any port.
- Applies to every scratch DB or Redis used for smokes too. See [[haive-serialize-full-suite-runs]].
