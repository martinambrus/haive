# Codex is steerable, through a transport we do not speak yet

> **Status — 2026-09-12.** Not started. Feasibility spike done and every blocker cleared
> against codex-cli 0.154.0 on live authenticated runs; the shapes below are measured, not
> read from docs. Decide the scope question in *Is it worth it* before picking this up.

## Context

`supportsSteering` is false for codex and that is correct for how we invoke it. Our steering
transport is NDJSON user-messages written to a running CLI's stdin (`steering.ts`), and
`codex exec` has no streaming input: it prints `Reading additional input from stdin...` and
waits for **EOF** before the first turn. Nothing in `codex exec --help` (0.154.0) accepts a
later message.

`codex queue --thread <id> --message <text>` looks like the way in and is not. MEASURED: it
accepts and persists the message (`Queued message <id> for thread <id>`, exit 0) while the
running `exec` never sees it — a three-command run continued to completion and answered its
original prompt with zero trace of the queued text, and a later `exec resume` carrying its own
prompt did not deliver it either. The `thread/queue/{add,list,delete,start,changed}` RPCs in
the binary belong to the app-server the TUI talks to, which is what `--remote <ADDR>` exists
for; `exec` subscribes to none of them.

`codex app-server` is the interface that does work. It is marked `[experimental]`.

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

`thread/start` also boots the MCP servers from the user's own config — `mcpServer/startupStatus/updated`
arrived for `filesystem`, `git` and `codex_apps` without us asking. That is a behaviour change
from `exec`, where our flags decide the MCP surface, and it has to be reconciled with
`mcp-surface.ts` before this ships.

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

So this is a `codex-appserver` variant of the existing parser, not a rewrite. `model_identity`
needs re-probing here: `exec --json` reports no model on any typed event, and whether app-server
does is unmeasured.

## D. Steering

```
--> {"jsonrpc":"2.0","id":4,"method":"turn/steer","params":{
      "threadId":"<threadId>","expectedTurnId":"<turnId>",
      "input":[{"type":"text","text":"<steer>"}]}}
<-- {"id":4,"result":{"turnId":"<turnId>"}}
```

`expectedTurnId` is a concurrency guard, and it is what makes steering **stateful** here: the
stream reader must track the live turn id and the steer path must read it. Today the forwarder
writes a line to stdin and knows nothing. The `steer: true` marker and
`steeringUserMessageLine` do not apply — they are the amp/claude stdin shape.

`steer_consumed` needs a new boundary signal. `onBoundary` currently keys on a `user` +
`tool_result` event; the equivalent here is most likely `item/completed`, unverified.

## E. What else comes free

- **`turn/interrupt`** is a real cancel. Today `cancelActiveCli` kills the container.
- **Per-turn usage** without parsing a result event.
- **`thread/resume` / `thread/fork`** exist, which the sub-agent emulator may later want.

## Files

- `packages/worker/src/cli-adapters/codex.ts` — a second invocation mode beside the exec argv.
- `packages/worker/src/cli-adapters/steering.ts` — a transport that is not stdin NDJSON.
- `packages/worker/src/queues/cli-exec/stream.ts` — the `codex-appserver` parse variant and its
  `onBoundary` key.
- `packages/worker/src/queues/cli-exec/exec-core.ts` — a spawn that writes requests, not only
  reads output.
- `packages/worker/src/sandbox/mcp-surface.ts` — reconcile with app-server booting MCP itself.
- `AGENTS.md` — the steering verdict table and the CLI adapter section.

## Verification

- Regenerate the schema on every codex bump: `codex app-server generate-json-schema --out <dir>`
  (266 files; there are both `v1/` and `v2/` trees). A renamed field surfaces as
  `-32600 Invalid request`, which is loud rather than silent — that is the mitigation for an
  experimental protocol, not a reason to skip re-probing.
- Re-run the spike shape: initialize → thread/start → turn/start → steer mid-turn → assert the
  agent abandons its original task, the turn completes, and usage is captured.
- Assert zero server→client requests under `never` + `dangerFullAccess`, so an approval landing
  in a non-interactive run fails the test rather than hanging a task.
- `adapter-steering.test.ts` flips codex to true only once a real steer has been observed
  end-to-end through the worker, not through a spike script.

## Is it worth it

**Not for steering alone.** Codex is one of ten adapters, and this trades a flag-bypassed
approval model for one we hand-implement against an experimental protocol with v1/v2 churn.

**Yes if codex is to be a first-class provider** — steering, a real cancel and per-turn usage
arrive together, and the spike has already removed the unknowns that would have made the
estimate a guess. Do it as its own branch; it touches the adapter, the stream parser, the exec
core and the MCP surface, which is more than belongs beside unrelated work.
