# Codex is steerable, through its app-server

> **Status — 2026-09-13.** Implemented on `feat/codex-app-server-steering`. A steerable codex
> dispatch runs on `codex app-server` once a zero-token probe has verified that provider in the
> task; `codex exec` stays the default and the fallback. Verified on live authenticated runs
> against codex-cli 0.154.0: the probe on workflow and plan_chat tasks, a mid-turn steer, the
> same-invocation exec fallback, the runtime downgrade and the admin switch. The lasting rules are
> in AGENTS.md (Steering); this file keeps the spike and what it turned into.

## Context

`codex exec`, the only way Haive invoked codex, cannot be steered. The steering transport was
NDJSON user-messages written to a running CLI's stdin (`steering.ts`), and `codex exec` has no
streaming input: it prints `Reading additional input from stdin...` and waits for **EOF** before
the first turn. Nothing in `codex exec --help` (0.154.0) accepts a later message.

`codex queue --thread <id> --message <text>` looks like the way in and is not. MEASURED: it
accepts and persists the message (`Queued message <id> for thread <id>`, exit 0) while the
running `exec` never sees it — a three-command run continued to completion and answered its
original prompt with zero trace of the queued text, and a later `exec resume` carrying its own
prompt did not deliver it either. The `thread/queue/{add,list,delete,start,changed}` RPCs in
the binary belong to the app-server the TUI talks to, which is what `--remote <ADDR>` exists
for; `exec` subscribes to none of them.

`codex app-server` is the interface that does work. It is marked `[experimental]`, which is why
the implementation verifies it in every task before relying on it (see *Is it worth it*).

## What the spike established

Every risk that would have killed this came back negative, on a copy of a real auth volume:

- **Plain piped stdio, no TTY.** The process stays alive and answers JSON-RPC 2.0 on
  stdin/stdout. This is what killed the grok REPL route (piped stdin dies `ENXIO`), so it was
  checked first.
- **No approvals to answer.** With `approvalPolicy: "never"` and
  `sandboxPolicy: { "type": "dangerFullAccess" }` a full turn produced **zero** server→client
  requests — the exact equivalent of today's `--dangerously-bypass-approvals-and-sandbox`. The
  protocol does define `ExecCommandApproval`, `ApplyPatchApproval`, `PermissionsRequestApproval`
  and `ToolRequestUserInput` as server→client requests; under that policy pair none fired.
- **Steering reaches a running turn.** `turn/steer` returned `{"turnId":"01a09728-…"}`, the
  agent abandoned the remaining work of a three-`sleep` task after the first command and
  answered `STEERED` instead of its original `DONE`, and the turn completed cleanly.
- **Token usage survives.** `thread/tokenUsage/updated` carries
  `{total:{totalTokens,inputTokens,cachedInputTokens,cacheWriteInputTokens,…}}` per turn.
- **The turn id is handed to us**, in the `turn/start` result — no scraping.

## A. The handshake and lifecycle

Four messages replace one argv. There is no `initialize` entry among the 266 generated schema
files, but the server requires it: a request sent first answers
`{"error":{"code":-32600,"message":"Not initialized"}}`.

```
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"haive","title":"Haive","version":"<APP_VERSION>"}}}
<-- {"id":1,"result":{"userAgent":"…","codexHome":"/home/node/.codex","platformFamily":"unix","platformOs":"linux"}}
--> {"jsonrpc":"2.0","method":"initialized","params":{}}
--> {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"<workdir>"}}
<-- {"id":2,"result":{"thread":{"id":"<threadId>","environments":[…],"ephemeral":false,…}}}
--> {"jsonrpc":"2.0","id":3,"method":"turn/start","params":{…}}
<-- {"id":3,"result":{"turn":{"id":"<turnId>","status":"inProgress",…}}}
```

As built, `thread/start` sends no `cwd` (it defaults to `/haive/workdir`) and carries the
thread-level pair `approvalPolicy:"never"` + `sandbox:"danger-full-access"`; its result names the
resolved `model` and `thread.cliVersion`, and both are recorded.

`thread/start` also boots the MCP servers from the user's own config — `mcpServer/startupStatus/updated`
arrived for `filesystem`, `git` and `codex_apps` without us asking. That needed no reconciling with
`mcp-surface.ts` after all: both transports read the same `~/.codex/config.toml` that `cli-merge`
writes (`initialize` reports `codexHome: /home/node/.codex`), and `codex exec` runs already
exposed `codex_apps`. The servers boot asynchronously once `thread/start` has answered — MEASURED
on live runs, ~0.3 s for `thread/start` and ~5 s from container start to `turn/started` — so they
never hold up the handshake.

Every protocol error is `-32600`: a request before `initialize`, an unknown method, a malformed
request, `thread not found`, `no active turn to steer` and a wrong `expectedTurnId` alike. So
nothing keys on an error's code or wording, only on success results and structural fields.

## B. `turn/start` — every exec flag has a field

| today (`codex exec`) | app-server |
|---|---|
| `--dangerously-bypass-approvals-and-sandbox` | `approvalPolicy:"never"` + `sandboxPolicy:{type:"dangerFullAccess"}` |
| `-m <model>` | `model` |
| `-c model_reasoning_effort=<e>` | `effort` |
| `-C <dir>` | `cwd` (and `thread/start.cwd`) |
| `--output-schema <file>` | `outputSchema` |
| prompt over stdin | `input: [{type:"text", text:"…"}]` |

Two shapes cost a failed request each and are not guessable:

- **`input` items are tagged.** A bare `{text:"…"}` is rejected `-32600 Invalid request: missing
  field 'type'`. Variants: `text`, `image`, `localImage`, `audio`, `localAudio`, `skill`,
  `mention`.
- **`sandboxPolicy` is tagged, not keyed on `mode`.** `{type:"dangerFullAccess"}`; the others are
  `readOnly`, `workspaceWrite`, `externalSandbox`, each with their own fields.
- `approvalPolicy` is the string enum `untrusted | on-request | never`, or an object with
  `granular`.

`effort` rides `turn/start` and does apply: MEASURED on live runs, the `thread/start` result
reports `reasoningEffort: null`, while the rollout's `turn_context` records `effort: "high"`.

## C. Event mapping — near, not identical, to `codex-jsonl`

The names carry the same meanings our parser already knows, with a different envelope: app-server
sends `{"method":"item/completed","params":{"item":{…}}}` where `exec --json` sends
`{"type":"item.completed","item":{…}}`. Observed on one trivial turn:

```
thread/started  thread/status/changed  turn/started
item/started  item/completed  item/agentMessage/delta
thread/tokenUsage/updated  account/rateLimits/updated  turn/completed
configWarning  remoteControl/status/changed  mcpServer/startupStatus/updated
```

As built, this became its own session module (`cli-executor/codex-app-server.ts`) rather than a
`stream.ts` variant, because the executor has to WRITE requests and correlate their responses, not
only read events — and responses settle synchronously during line parsing, since one stdout chunk
can carry the `turn/start` result and that turn's `turn/completed`. The delta streams are opted
out at `initialize` (`capabilities.optOutNotificationMethods`, honoured); the answer is the last
`agentMessage` from `item/completed` (live phases `commentary`, then `final_answer`); usage is the
last `thread/tokenUsage/updated` `total`, mapped through the helper `codex exec` already uses, so
codex's input-includes-cache arithmetic is unchanged. For `model_identity`, `thread/start` names
the model it resolved (recorded as `requested`), and a served model appears only on
`model/rerouted`.

## D. Steering

```
--> {"jsonrpc":"2.0","id":4,"method":"turn/steer","params":{
      "threadId":"<threadId>","expectedTurnId":"<turnId>","clientUserMessageId":"<steerId>",
      "input":[{"type":"text","text":"<steer>"}]}}
<-- {"id":4,"result":{"turnId":"<turnId>"}}
```

`expectedTurnId` is a concurrency guard, and it is what makes steering **stateful** here: the
session tracks the live turn id, and a steer written before `turn/start` has answered is queued
until it has. The forwarder gained a `deliver` hook, so the session sends `turn/steer` while
tracking, the echo and the teardown stay shared with the stdin CLIs. The `steer: true` marker and
`steeringUserMessageLine` do not apply — they are the amp/claude stdin shape.

`steer_consumed` keys on the injected `userMessage` item. MEASURED on a live plan_chat turn: a
steer sent during the third of three `sleep 20` calls answered with the live `turnId`, codex
emitted a `userMessage` carrying `clientId` equal to our `clientUserMessageId` once that call
returned, and the reply answered the steer. A binary that echoes no client id is drained in arrival
order instead. A refused steer is not a transport failure, because a steer racing the turn's end is
refused with the same `-32600` as everything else.

## E. What else comes free

- **`turn/interrupt`** is a real cancel. As built, the probe uses it, and so does the guard that
  refuses a server→client request; a user's cancel still stops the container.
- **Per-turn usage** without parsing a result event.
- **`thread/resume` / `thread/fork`** exist, which the sub-agent emulator may later want.

## Files

- `packages/worker/src/cli-executor/codex-app-server.ts` — the JSON-RPC line client and the
  one-turn session.
- `packages/worker/src/cli-adapters/codex-app-server-probe.ts` — the zero-token probe.
- `packages/worker/src/cli-adapters/codex-app-server-verdict.ts` — per-task verdicts
  (`tasks.codex_app_server`, migration 0157) and the downgrade task event.
- `packages/worker/src/cli-adapters/codex.ts` — the app-server spec beside the unchanged exec argv,
  and `codexExecFallbackSpec`.
- `packages/worker/src/orchestrator/dispatcher.ts` — `steeringTransportReady` and the lazy probe.
- `packages/worker/src/queues/cli-exec/exec-core.ts` — session wiring, the handshake deadline and
  the same-invocation fallback; `handlers.ts` — the runtime downgrade and the step warning.
- `packages/worker/src/queues/cli-exec/steer-forwarder.ts` — the `deliver` hook.
- `packages/api/src/routes/admin.ts`, `packages/web/src/app/(app)/admin/page.tsx` — the switch
  and the recorded-failures list.
- `AGENTS.md` — the steering verdict and the three layers.

## Verification

- Regenerate the schema on every codex bump: `codex app-server generate-json-schema --out <dir>`
  (266 files; there are both `v1/` and `v2/` trees). A renamed field surfaces as
  `-32600 Invalid request`, which is loud rather than silent — and the probe now turns exactly
  that into a per-task verdict, so it lands on `codex exec` instead of on a failed step.
- The probe is the spike shape run at zero tokens in every task: initialize → thread/start →
  turn/start → turn/steer → turn/interrupt → turn/completed, unauthenticated and with no network,
  because an unauthenticated turn stays active for 20+ s while codex retries its connection.
  MEASURED on real binaries: 0.40.0 is unsupported at `spawn` (no `app-server` subcommand), 0.78.0
  at `spawn` (it rejects `--disable multi_agent_v2`, and at `steer` without that flag), and
  0.122.0 and 0.154.0 are supported.
- A server→client request under `never` + `dangerFullAccess` is answered with an error,
  interrupts the turn and is a `server_request` transport failure, so an approval landing in a
  non-interactive run fails the run rather than hanging a task.
- `adapter-steering.test.ts` flipped codex to true after a real steer was observed end to end
  through the worker (section D), not through a spike script.
- Live checks run on 2026-09-13: probe `supported` on a workflow task and on a plan_chat task; the
  canary and triage on app-server; the mid-run steer above; a provider whose stored args break only
  the app-server argv, which the probe recorded `unsupported` at `spawn` and which then ran on
  exec; the same verdict forced to `supported`, which failed before the turn, re-ran on exec in the
  same invocation and recorded the runtime verdict the admin list shows; and the admin switch off,
  which sent a verified provider to exec with no probe.
- That fallback check also found why the step warning is not enough on its own: plan_chat's revise
  loop reset the row 0.3 s after the warning was written, so every `unsupported` verdict is also a
  task event on the Activity tab.

## Is it worth it

The spike's answer was "not for steering alone": codex is one of ten adapters, and this trades a
flag-bypassed approval model for one hand-implemented against an experimental protocol with v1/v2
churn. Steering was taken on its own anyway, on the one condition that makes an experimental
protocol acceptable — nothing relies on it until it is verified in the task, every way it can
fail lands on `codex exec`, the path that already worked, and an admin switch covers what the
probe cannot see. A real cancel and per-turn usage remain available if codex later becomes a
first-class provider.
