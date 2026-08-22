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

# Amendment — 2026-08-22: both items shipped

Both items are done. The body is left byte-identical above; this records what actually happened,
including where the original recommendation was wrong.

## Item 1 — shipped in `c094102`

`--init` added to the DDEV runner's and the app-runner's `docker run` args. Verified by A/B against
the real runner image rather than by reasoning about tini: orphaning 5 processes leaves 5 zombies
without `--init` and 0 with it, PID 1 becomes `docker-init`, and the nested dockerd still comes up
healthy under it (ServerVersion 29.7.2) with `--privileged` unchanged.

The app-runner was included on evidence rather than symmetry, as the body asked. Its
`start-browser-desktop.sh` orphans by design (`nohup chromium ... &`, then the script exits), so
Chromium's helpers reparent to PID 1 and zombie on exit — observed directly as defunct chromium
entries under PID 1 `sleep`.

## Item 2 — shipped in `e066d26`, and the body's recommendation was too pessimistic

The body recommended weighing option 3 carefully because it assumed the proxy would have to STRIP
bodies from the response. Reading `converNetworkRequestDetailedToStringDetailed` showed that is not
necessary: when `requestFilePath` / `responseFilePath` are set, upstream never renders the body at
all, it renders `Saved to <path>.` instead. So the proxy only ever rewrites the REQUEST, and the
cost and risk that drove the original hesitation both drop:

- No response parsing, so no dependence on the rendered text (`### Request Body` headings) — which
  would have been the ephemeral-value trap the body was worried about.
- The child's stdout is inherited, not piped through a parser, so the response path is byte-exact.
- Failure is open by design: unparseable lines and every other method are forwarded verbatim.

Bodies are written to `os.tmpdir()`. That is not only repo-hygiene: upstream's own startup warning
confirms the OS temp directory is the one location it permits when the client negotiates no MCP
roots, so the choice holds with and without `--allow-unrestricted-paths`.

Option 2 from the body (asking agents to pass the paths themselves) was not used and remains the
right call to have rejected — the proxy makes it unconditional instead of trusting compliance.

### What is still unverified

The rewrite logic and the `initialize` handshake through the proxy were tested directly. There is no
end-to-end test against a live page's network request, because that needs a running app. The first
real browser-verify task is the remaining check: confirm `get_network_request` returns
`Saved to /tmp/haive-net-...` rather than a body, and that 08a / Gate 2 / the fix loop are unchanged.

### Scope reminder

This is a leak reducer, not a containment boundary. The agent can read the file back, and it is
already authorised to see the app's data on screen. What it stops is a body being swept into a
third-party model provider's context as a side effect of asking about a request.

# Amendment — 2026-08-22: item 2's end-to-end check closed

The check the first amendment left open is done, but NOT the way it expected. It assumed a
real browser-verify task would exercise `get_network_request`. Watching task `de98d843`
through `08a-browser-verify` showed the agent genuinely driving the browser — 7
`navigate_page`, 8 `take_screenshot`, 6 `list_console_messages`, 5 `list_network_requests`
— and never calling `get_network_request` once. That confirms the body's own scope note in
the wild: nothing in Haive steers an agent to the one tool that returns bodies, so waiting
for the natural path would not have produced the proof.

Forced instead, through the real proxy, a real headless Chromium and a local endpoint
returning a secret in BOTH a `Set-Cookie` header and a JSON body. `get_network_request` was
called with only a `reqid` and no file paths, i.e. exactly what an agent sends:

    ### Response Body
    Saved to /tmp/haive-net-23-2-response.network-response.
    set-cookie:<redacted>

    HAS_SAVED_TO=true   HAS_HAIVE_NET=true   HAS_REDACTED=true
    LEAKS_BODY_TOKEN=false   LEAKS_COOKIE=false

So the proxy injected the path, upstream diverted the body to disk rather than rendering
it, and neither the body token nor the cookie value reached the model-visible text. Both
`139dc14` (headers) and `e066d26` (bodies) are now verified against real traffic.

Separately confirmed in production during the same run: the proxy is on the real path. A
live sandbox showed the full chain — `node haive-chrome-mcp-proxy.mjs` -> `npm exec` ->
`chrome-devtools-mcp` — and the CLI reported `"chrome-devtools":"connected"` on every
invocation after `cdf7ebe`, where it had reported `"failed"` before.

## Two defects found while verifying, neither recorded elsewhere

1. **The headless fallback cannot launch a browser in a browserTesting env image.**
   `mcp-config.ts` pins `SANDBOX_CHROME_PATH = /usr/bin/chromium` and the generated env
   Dockerfile sets `ENV CHROME_PATH=/usr/bin/chromium`, but that env image is Ubuntu 24.04,
   where `apt-get install chromium` yields only `/usr/bin/chromium-browser` — a snap
   redirect stub that prints "snap install chromium" and exits 1. There is no
   `/usr/bin/chromium`. MEASURED: the MCP answers `Browser was not found at the configured
   executablePath (/usr/bin/chromium)`. `67b297a` fixed this for the CLI sandbox image
   (Debian bookworm, real binary present); the env-replicate generator still installs the
   Debian package name on an Ubuntu base. Production masks it because `08a` runs with the
   desktop up and takes the `--browser-url` branch, so the headless fallback is only
   reached when there is no runner browser — exactly when it is needed most.

2. **The headless branch passes no `--no-sandbox`.** With a real Chromium present, the
   launch still dies with `Protocol error (Target.setDiscoverTargets): Target closed` until
   `--chrome-arg=--no-sandbox` is added. Puppeteer's defaults do not include it, and
   `start-browser-desktop.sh` passes it explicitly for the headed desktop, so only the
   headless self-launch lacks it.

Both are unfixed and out of scope for this plan; they belong with F7/F8 in
`curious-drifting-lantern.md`.

# Amendment — 2026-08-22: the two defects above are fixed, plus a third found with them

The second amendment recorded two browser defects as unfixed. Both are now fixed, along with
a third that surfaced while investigating them. Planned in
`~/.claude/plans/majestic-questing-bumblebee.md`.

- **Headless launch could not start a browser** — `b7884e6`. Chrome's own sandbox cannot nest
  inside the cli-exec container, so the self-launch died with `Target closed` before any tool
  ran. `--chrome-arg=--no-sandbox` and `--chrome-arg=--disable-dev-shm-usage` on the headless
  branch only; `browser-check.js` and `start-browser-desktop.sh` already passed both, so the
  MCP self-launch was the one path that omitted them.

- **Ubuntu env images had no browser at all** — `0580c51`. Ubuntu ships no chromium deb, so
  the browser now comes from Google's apt repo and is symlinked to `/usr/bin/chromium`, the
  path every consumer already assumed. The Chrome for Testing zip was chosen first and then
  rejected on evidence: it pulls no system libraries, and MEASURED, libnss3, libasound2,
  libatk, libcups, libpango, libxkbcommon and libatspi are all absent from that image, since
  `apt install chromium` was what used to drag them in. The block now ends with
  `RUN /usr/bin/chromium --version`, so a base that cannot produce a browser fails the BUILD
  rather than shipping an image that fails hours later inside a verification step.

- **A poisoned npx cache tree broke the filesystem MCP forever** — `507cb84`. Found while
  reading the same init events. The cache is never validated or expired, so one truncated
  install fails every later invocation. `warmNpmPackage` now purges that package's `_npx`
  trees and retries once, and `@modelcontextprotocol/server-filesystem` is warmed
  deliberately rather than cached by accident. The probe args are per-package and are not
  interchangeable: `--version` is a real flag to chrome-devtools-mcp, but server-filesystem
  reads its arguments as directories and exits 1 on `--version` even when healthy, so probing
  it that way would have purged a good tree on every warm.

## Bandwidth, since it is the operative cost here

A browserTesting env build pulls 344 MB, of which 96.9 MB was the same package index fetched
three times — each apt block ends by deleting `/var/lib/apt/lists`, so the next one re-fetches
all 32.3 MB of it. The browser and X stack were therefore merged into a single apt block,
repo setup included, saving one full index fetch. The remaining repetition is in the older
blocks (base tools, node, PHP) and is untouched; collapsing those is an open, separate saving
of roughly 64 MB per build.

Editing `renderDockerfile` changes `dockerfile_hash`, so every browserTesting env template
rebuilds once and pays this.

# Amendment — 2026-08-22: the two "unavoidable" bandwidth costs were neither

The previous amendment left two costs standing as inherent. Both were artefacts of how they
were measured, and both are now MEASURED away.

**`--no-cache` defeating the mounts is not a path this system takes.** It was observed only
because the benchmark passed the flag. `buildImage` (`sandbox/docker-runner.ts`) builds with
`['build', '--progress=plain', '-t', tag]` plus an optional `-f`, `--build-arg` and the context
dir, and `ensureDdevRunnerImage` with `['build', '-t', tag, dir]`. Nothing in the repository
passes `--no-cache` to `docker build` — the only matches anywhere are `pip --no-cache-dir`,
which is unrelated. A forced rebuild would indeed pay full price; nothing forces one.

**"Every browserTesting template rebuilds once" does not mean every template pays.** The
package half of the cache works: with `docker-clean` removed, an install leaves its `.deb`s in
the `/var/cache/apt` mount (MEASURED: 71 of them after one install). A SECOND image — different
early layer, so no layer cache at all — installing the same packages then fetched **0 files,
0.00 MB**, with 0 `Get:` and 4 `Hit:`: both the index and the packages came from the mounts.

So the ~248 MB is paid ONCE PER HOST, not once per template. Every browserTesting template
installs the same browser and X stack, so that shared portion is nearly the whole of it, and
later templates pay only for packages no earlier template pulled.

The remaining honest caveat is narrow: the mounts live on the builder, so a pruned builder
(`docker builder prune`) or a fresh host starts cold again. That is the same class as the
existing "never blanket prune" rule for images and volumes.
