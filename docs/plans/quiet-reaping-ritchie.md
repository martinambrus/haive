# quiet-reaping-ritchie — DevTools egress hardening follow-ups

Status: Not started
Origin: deferred out of the chrome-devtools egress work (`b301ce9`, `d66f5c6`, `139dc14`), 2026-08-22.

Two items were measured during that work, found real, and deliberately left out because each is a
different kind of change from the flag-setting the three commits did. Neither is a regression in
those commits; both are pre-existing.

---

## Item 1 — Runner PID 1 never reaps, so zombies accumulate

### What was measured

On a live DDEV runner (`haive-ddev-c91491f6`), 2026-08-22:

- PID 1 is `sleep`, because `docker/ddev-runner/entrypoint.sh` ends in `exec "$@"` and the
  Dockerfile's `CMD` is `["sleep", "infinity"]`.
- `dockerd` is started backgrounded by that entrypoint. Its nested `containerd-shim` children,
  when orphaned, reparent to PID 1.
- `sleep` never calls `wait()`, so they stay as zombies: **197 zombies out of 265 total processes**,
  nearly all `containerd-shim` with PPID 1.
- `pids.max` is 8192, so at that count nothing is failing yet. The concern is unbounded growth over
  a long-lived runner, not a current outage.

This is pre-existing and unrelated to the browser privacy switches; it was found while cleaning up
test processes from that work (which added roughly 15 more zombies of the same kind).

### Proposed fix

Add `--init` to the runner's `docker run` args in `sandbox/ddev-runner.ts` (`buildRunArgs`, the array
that already carries `--privileged` / `--name` / labels). Docker's `--init` installs tini as PID 1,
which reaps reparented children. Entrypoint and CMD are unchanged: tini becomes PID 1, `entrypoint.sh`
runs as its child, and `exec "$@"` still replaces that shell with `sleep infinity`.

Check whether the app-runner (`sandbox/app-runner.ts`) wants the same treatment. It is also a
long-lived `sleep infinity` container, but it is not Docker-in-Docker, so it produces far fewer
orphans; decide from a measurement there rather than by symmetry.

### Why it is not a one-line drive-by

`--init` changes PID 1 for a **privileged Docker-in-Docker** container, which affects signal
delivery and shutdown ordering for the nested `dockerd`. It has to be verified against a real DDEV
task (boot, `ddev start`, a browser-verify step, then teardown), not just a container that starts.

### Verification

1. Start a task that boots a DDEV runner, let it run a step that spawns nested containers.
2. `ps -eo stat | grep -c '^Z'` inside the runner stays flat instead of climbing.
3. `ps -p 1 -o comm=` reports the init process, not `sleep`.
4. Teardown still works: `docker rm -f -v` completes, and no dangling nested state is left.

### Rollback

Remove the `--init` argument. It is a per-container run flag with no persisted state, so removing it
returns the next runner to current behaviour. Runners already started with it are unaffected by the
removal and are reaped normally at task end.

---

## Item 2 — chrome-devtools-mcp still returns request/response bodies to the model

### What was measured

`139dc14` set `--redact-network-headers`, which closes the header channel. Verified against the
1.7.0 bundle: upstream `sanitizeHeaders` is an allow-list, so `cookie`, `set-cookie`,
`authorization`, `proxy-authorization`, `x-api-key` and `x-csrf-token` all become `<redacted>`.

Bodies are NOT covered. In `formatters/NetworkFormatter.js`, `toJSONDetailed()` returns
`requestBody` and `responseBody` verbatim. There is no server-side switch for this:
`requestFilePath` / `responseFilePath` are parameters on the `get_network_request` TOOL, supplied by
the agent per call, and the schema says "If omitted, the body is returned inline."

Scope of the exposure, measured rather than assumed:

- `list_network_requests` returns `toJSON()`, which carries no headers and no bodies. Only
  `get_network_request` returns `toJSONDetailed()`.
- No Haive prompt directs an agent to call `get_network_request`. The only network tool named in
  agent-facing text is `list_network_requests` (`cli-adapters/model-capabilities.ts`).
- So the path is reachable on an agent's own initiative — plausible for one debugging a failing
  request — but not one Haive steers agents into.

Marginal value is lower than the header fix was, for one specific reason worth keeping in mind: in
the login case the credential in a request body is the one the agent itself just typed via
`_app-auth.ts`, so it was already in that agent's context. The genuinely new leak is a RESPONSE body
carrying a token the agent did not already know (a session JWT, an API key in a JSON payload).

### Options considered

1. Server flag — does not exist. Confirmed against the 1.7.0 CLI options.
2. Tell agents to always pass `responseFilePath` / `requestFilePath`. Cheap, in-repo, but
   unreliable: it depends on agent compliance, and the file lands in the worktree where the agent
   can read it straight back into context.
3. A Haive-owned stdio MCP proxy between the CLI and `chrome-devtools-mcp` that strips the body
   fields from tool results. Architecturally consistent with what already exists (`haive-rag` and
   `ddev-control` are bind-mounted stdio servers; `openrouter-compat-proxy` is a request rewriter).
4. Disable the network tool category (`--no-category-network`). Rejected: it removes the console and
   network evidence the browser-MCP fix loop and the Gate 2 reject path depend on.

### Recommendation

Option 3, as its own change, if it is worth doing at all. It puts a new process in the hot path of
every browser tool call, so a bug there breaks all browser verification — a different risk class
from the three flag commits, which cannot break the browser loop. Weigh that against the narrowed
exposure above before building it.

### Verification

A real browser-verify task where an agent calls `get_network_request` against an authenticated
request, then confirm the tool result reaching the CLI carries neither body, while
`list_network_requests`, console messages and the fix loop still behave unchanged.

### Rollback

Remove the proxy from the server spec in `sandbox/mcp-config.ts` so the CLI launches
`chrome-devtools-mcp` directly again. No persisted state, no migration.
