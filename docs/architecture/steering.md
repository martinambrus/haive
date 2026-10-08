# Steering

Mid-run steering is a user message delivered to a RUNNING CLI, applied at its next
boundary — an NDJSON line on stdin for most CLIs, a `turn/steer` JSON-RPC request for codex.
`supportsSteering` is read in exactly ONE place (`dispatcher.ts`, ANDed with the step's
`steeringRequested` and with `steeringTransportReady`, the per-task half only codex overrides)
and reaches the browser only as the per-invocation `cli_invocations.steerable` column — no
capability travels to web, which is why there is nothing to keep in sync in `@haive/shared`.

**The capability set goes stale silently, so re-probe it.** It was set in June 2026 and by
September amp had shipped steering without anything noticing — `adapter-steering.test.ts`
asserted seven adapters and amp was not one of them. It now asserts ALL ten, false ones
included. Verdicts as of 2026-09-12 (codex revised 2026-09-13), each against the vendor's
current docs and, where installed, the binary's own `--help`:

- **claude family** (`claude-code`, `zai`, `ollama`, `muse`, `openrouter`) — `--input-format
stream-json`, stdin held open, one NDJSON user-message per steer.
- **amp** — `--stream-json-input` ("Read JSON Lines user messages from stdin. Requires both
  --execute and --stream-json", quoted from the shipped image's own `--help`) plus a
  top-level `"steer": true`, which means "apply at the next interruption point while the
  agent is busy". `-x, --execute [message]` takes an OPTIONAL value, so bare `-x` with the
  message on stdin is the shape the adapter already used for an oversized prompt.
  MEASURED against 0.0.1789200043-gdb3b35, because two things had to hold before the flag
  could be set. Its stream DOES emit the `user` + `tool_result` event `onBoundary` keys on
  (`system, user, assistant, user, assistant, result` for a one-tool run) — without it
  `steer_consumed` would never publish and every amp steer would sit at "queued" until exit
  relabelled it "the run ended before this was applied", telling the user their steer was
  ignored when it was not. And a `steer: true` line written 6s INTO a run was received and
  applied: the agent abandoned its original task and answered the steer verbatim, then
  exited 0 once stdin closed — which is what makes the forwarder's `onResult` latch plus its
  750 ms grace the right shutdown for it. amp also echoes each stdin message back as a
  text-only `user` event, which is harmless in both directions: `onBoundary` ignores a user
  event carrying no `tool_result`, and `onText` reads assistant blocks only.
- **codex** — YES, through `codex app-server`, and only where it was verified; `codex exec`
  stays the default and the fallback. `exec` is fire-and-forget (it prints `Reading additional
input from stdin...` and waits for EOF before the first turn), and `codex queue --thread <id>
--message <text>` is NOT a way in: MEASURED against 0.154.0 on a live authenticated run, it
  accepts and persists the message (`Queued message <id> for thread <id>`, exit 0) while the
  running `exec` never sees it, and a later `exec resume` with its own prompt did not deliver it
  either — the `thread/queue/*` RPCs belong to the app-server the TUI talks to. The app-server is
  JSON-RPC 2.0 over plain piped stdio (`cli-executor/codex-app-server.ts`): `initialize` →
  `thread/start` → `turn/start`, each steer a `turn/steer` carrying `expectedTurnId` and a
  `clientUserMessageId`, and consumption is the turn's `userMessage` item echoing that client id
  (drained in order when a binary echoes none). MEASURED on a live plan_chat turn: a steer sent
  during the third of three `sleep 20` calls answered with the live `turnId`, the `userMessage`
  carrying its client id arrived once that call returned, and the reply answered the steer. How it
  is verified and abandoned is below.
- **grok** — NO. Headless `-p` streams are read-only and the REPL needs a TTY (piped stdin
  dies ENXIO, already recorded in `grok.ts`). Only ACP (`grok agent stdio`) is bidirectional.
- **antigravity** — NO, and it is the closest miss. It already passes `--input-format
stream-json` and writes an NDJSON prompt on stdin, but as `stdinPrompt`, which CLOSES; its
  docs say to wait for the `result` event before writing again. That is a queued follow-up
  TURN, not a mid-turn steer, and there is no `steer:true` equivalent to queue one.
- **gemini** — NO. Stdin carries at most a prompt too large for argv, never a later
  message; mid-run injection is an open upstream feature request.

**codex steers through an EXPERIMENTAL protocol, so each task verifies it before relying on it
and falls back to `codex exec` the moment it does not hold.** The app-server is marked
`[experimental]`, and older binaries lack it or part of it — MEASURED on real images: 0.40.0 has
no `app-server` subcommand, 0.78.0 has an app-server with `turn/start` and `turn/interrupt` but no
`turn/steer`, and 0.122.0 and 0.154.0 pass the probe. Three layers:

- **A zero-token probe on a provider's first steerable dispatch in a task**
  (`cli-adapters/codex-app-server-probe.ts`, called from `resolveTaskDispatch`; in onboarding and
  workflow tasks that dispatch IS `00-model-health`, whose progress line states the verdict). The
  provider's own image and argv run with NO credentials and NO network, which is what makes it
  free: MEASURED on 0.154.0, `turn/start` still answers `inProgress` and the turn stays active for
  20+ s while codex retries its connection, so `turn/steer` (must answer `result.turnId`),
  `turn/interrupt` (only accepted after `turn/started`) and `turn/completed` are all exercised with
  no model call. The verdict lands in `tasks.codex_app_server` per provider (migration 0157) and is
  current only while the provider's `cli_version` still matches. An inconclusive probe (docker
  exit 125, a turn that ended before its steer was answered) records nothing and the next
  dispatch probes again. ASSUMED, not measured: a future codex that refuses turns without a login
  would read as `unsupported` — which fails toward exec, the safe direction.
- **An in-invocation fallback when the app-server cannot accept the turn** (spawn, initialize,
  thread/start, turn/start, or no accepted turn within 5 min): no work was done, so exec-core
  re-runs the SAME invocation from `codexExecFallbackSpec` (the adapter's exec argv, prompt over
  stdin) and returns that. Before that exec half starts the row stops claiming `steerable` and a
  `steerable` stream frame drops an open terminal's steer box, so no steer is accepted that nothing
  will read. A binary that exits before answering `initialize` is `spawn` here
  exactly as in the probe, with its stderr tail as the detail — MEASURED, that tail was clap's
  `unexpected argument '--json' found`, the one line naming what changed, where the session alone
  could only say the process had exited. A failure after the turn was accepted — a server->client
  request under `never`/`dangerFullAccess`, a stream that ended without `turn/completed`, a
  completed turn with neither usage nor a message — cannot be re-run blindly, since the agent may
  have edited files, so it fails as `CODEX_APP_SERVER_FAILED_HEADLINE`, a transient the step's
  existing re-dispatch re-runs. Either way `handleCliExecJob` first records `unsupported`/`runtime`
  for that provider, so every later dispatch in the task — that re-run included — builds
  `codex exec`, and the step carries a `warningMessage` naming the stage and codex version. That
  banner cannot be the only trace: a self-revising step resets its own row at the end of the turn
  that set it — MEASURED on plan_chat, the warning was cleared 0.3 s after it was written — so
  every `unsupported` verdict, probe or run, is also a `codex_app_server.unavailable` task event on
  the Activity tab. A run that behaved still reports `thread.cliVersion`; one that differs from the
  verdict's binary (a provider left on "latest" whose image was rebuilt) drops the verdict, so the
  next dispatch re-probes the new binary. Haive's own kills (timeout, cancel, preemption) never
  count, and neither does Docker's own exit 125: a container that never started says nothing about
  codex, which is how the probe already read it.
- **`CONFIG_KEYS.CODEX_APP_SERVER_ENABLED`** (default on, Admin > CLI execution) for what the probe
  cannot see: off sends every newly dispatched codex run through `codex exec`. The same card lists
  the last 30 days of `unsupported` verdicts with their codex version and stage — the report Haive's
  protocol support is updated from when a codex release changes the API.

Four measured facts to keep. EVERY app-server error is `-32600` — an unknown method, a malformed
request, `thread not found` and `no active turn to steer` alike — so nothing may key on an error's
code or wording, only on success results and structural fields; that is also why a single refused
steer is NOT a downgrade, since a steer racing the turn's end is refused the same way. codex exits
~0.12 s after stdin EOF when no turn ran but ~5.1 s after an interrupted one, with the image's
entrypoint and without it. And the MCP surface needs no reconciling: both transports read the same
`~/.codex/config.toml` that `cli-merge` writes (`initialize` reports `codexHome:
/home/node/.codex`), and `codex exec` runs already expose `codex_apps`. Those servers boot
asynchronously once `thread/start` has answered — MEASURED on live runs, ~0.3 s for `thread/start`
and ~5 s from container start to `turn/started` — so they never hold up the handshake the 5-min
deadline guards. Finally, codex's multi-agent feature goes off with
`-c features.multi_agent_v2=false` and never `--disable multi_agent_v2`, although codex's help calls
them equivalent: `--disable` refuses a feature name the binary does not know (0.154.0 answers
`--disable no_such_feature` with "Unknown feature flag", exit 1, and 0.78.0 refused every exec and
app-server start that way) while `-c` ignores one, and `codex features list` shows both forms
setting the same flag.

**The steer is echoed by US, because the binary never echoes it.** `steer-echo.ts` fans one
written steer to three places from the forwarder's `onWritten`: a `steer` stream frame
(live), the Clean transcript (persisted), and the stream-log buffer (the persisted Raw tab).
Three details are load-bearing:

- The frame is its OWN top-level type, not a value on `output`'s `stream` union. The viewer
  routes any non-`text` output straight into xterm, so an output-shaped frame would be
  echoed raw by any client that has not shipped the inline rendering — and `output` is in
  the viewer's stall-clock frame set, so a steer published there would restamp "the CLI is
  talking" on exactly the frozen run someone is steering.
- The Raw line goes into the buffer ONLY, never a second publish. The viewer draws the live
  line from the steer frame itself; publishing both draws it twice.
- The soft-timeout wind-down rides the same channel and is marked `system` AT ITS SOURCE, so
  it still reaches the CLI but is not rendered as something a person typed. Marked rather
  than inferred from an empty id, because an empty id already means "legacy bare-string
  steer", which IS human — the same distinction that makes `publishCliSteerConsumed` drop an
  empty id while `publishCliSteer` keeps one.

**Both sides of the optimistic append have to be idempotent.** The sender adds its own turn
when the POST resolves, but the worker publishes the frame the moment the text reaches
stdin, so the frame routinely arrives FIRST. Guarding only `applySteerFrame` left the race
open from the other direction — MEASURED in the browser against a live plan-chat run, one
steer rendered as two identical `You ✓` turns while the persisted transcript held exactly
one. `appendUserTurn` is idempotent on a non-empty id for that reason.

`cli_invocations.clean_transcript` is the durable half (migration 0156): ordered segments,
model prose interleaved with the user turns at the positions they were injected. It is a
SECOND column rather than part of `raw_output` because that column is also the step parsers'
input, so a human sentence there is handed to a JSON parser as the agent's answer. NULL
means "not recorded" — every pre-existing row, and any run with no model prose, where
`raw_output` is the only copy of the answer and a transcript would hide it.
