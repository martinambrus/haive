# Message threads and incremental-request transports for agent CLIs

> Status: Not started. Written 2026-11-10 from `threads.pdf` (a paywalled Medium post; only its
> intro survives in the PDF) plus primary sources listed at the end.

## 1. What the feature is

Anthropic Messages API beta `message-threads-2026-08-12` (released 2026-11-02). A request carries
`thread: {type: "create"}` on the first turn, then `thread: {type: "continue", previous_message_id}`
with only the new messages (no `system`, no `tools`). The server holds the conversation in memory
for 5 minutes after its last request (hard cap 1 hour). On `thread_not_found` the client replays
the full conversation in a new create. Not ZDR eligible; not available on Bedrock or Vertex AI;
incompatible with compaction, most context editing, batches and token counting.

## 2. Does it save tokens or bandwidth

- Tokens: NO. Docs: "Threads do not change pricing or rate limits." Blog: "token usage stays the
  same", because the model still reads the whole conversation each turn. Billing still rides
  prompt caching exactly as before.
- Bandwidth: YES, upload side. A continue request sends only the new turn instead of the whole
  history; in a long tool loop that is the difference between O(turns) and O(turns^2) bytes
  uploaded over a run.
- Latency: YES. Anthropic reports a ~35% median time-to-first-token drop on 500k-1M token
  requests. The server skips re-validating and re-tokenizing the history.

Conclusion: a wall-clock and bandwidth lever, not a token or cost lever. Haive's token reduction
work (caching, `disableTools`, prompt size) is unaffected by this plan.

## 3. Haive's position

Haive never calls the Messages API itself; it spawns CLI binaries in sandboxes
(`packages/worker/src/cli-adapters/`). Threads therefore happen, or not, INSIDE each binary, per
invocation. Every invocation is a fresh process, so a thread spans one invocation's tool loop and
never crosses invocations (that would also exceed the 5 minute idle expiry between most steps).
The work is: make sure each binary that supports an incremental transport actually uses it under
Haive's sandbox, measure it, and pin the conditions so a later change does not silently turn it off.

## 4. Per-CLI findings

### claude-code (and claude-binary wrappers)

MEASURED by reading the Claude Code 2.1.322 binary (minified; internal name "tether"):
- Already implemented and on by default when ALL hold: API provider is first-party (not
  Bedrock/Vertex); `ANTHROPIC_BASE_URL` unset or first-party; `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  unset; org not HIPAA or ZDR; server-side feature flag on (GrowthBook remote eval, the
  "most Claude Code users" rollout).
- Undocumented tri-state env `CLAUDE_CODE_TETHER_LIVE` overrides the feature flag. It is internal
  and VOLATILE: do not key code on it.
- Falls back to stateless automatically on any thread error (logs `[tether] ...` lines in debug).

Haive's `claude-code` adapter (`claude-code.ts`) sets none of the blockers, so sandboxed runs
should already be threaded. Unverified: whether the feature-flag fetch succeeds through the squid
egress allowlist (`defaultEgressDomains = ['api.anthropic.com']`); a failed fetch leaves the flag at
its default `false`, which silently disables threads.

zai, openrouter, ollama, muse (claude binary pointed at another `ANTHROPIC_BASE_URL`): the binary
turns threads off for a non-first-party base URL, and none of those backends implement the beta.
Nothing to do. Haive's two proxies (`openrouter-compat-proxy`, `ollama-thinking-proxy`) are never in
the path of an Anthropic call.

### codex

OpenAI's equivalent is Responses API WebSocket mode: one persistent connection to
`/v1/responses`, each turn sends only new input items plus `previous_response_id`, server keeps
the last response in a connection-local cache (ZDR compatible). Codex 0.167.0 ships it
(`responses_websockets` feature, per-provider `supports_websockets`, `prefer_websockets`); third-party
reports say it is the default transport for the built-in OpenAI provider, with HTTPS fallback.
Unverified in Haive: whether the WebSocket upgrade survives the squid CONNECT tunnel and the
codex `exec` and `app-server` paths both use it, or whether every run silently falls back to HTTPS.

### gemini, grok, amp, antigravity

- gemini CLI 0.29.5 (host install): no stateful transport found (no `previous_interaction_id`).
  Out of scope until a release adds one.
- grok, amp, antigravity (agy): proprietary or unmeasured backends. One check each in Phase 1; act
  only on a positive finding.

## 5. Plan

Rollback for every phase: all changes are tests, docs or config; reverting the PR restores the
previous state. No migration, no data change.

### Phase 1: measure (no code)

1. Pick one representative multi-turn step (e.g. an implementation step) on a scratch task.
   Run it on `claude-code` twice with the same prompt and model: provider envVars
   `CLAUDE_CODE_TETHER_LIVE=0`, then `=1`. Provider envVars already reach the binary
   (`mergedEnv`), so no code is needed.
   Verify: squid access log bytes for the `api.anthropic.com` CONNECT tunnel per run; wall clock;
   identical `token_usage` (expected, since tokens do not change).
2. Run the same step with no override. Verify with the binary's debug log (`--debug` written to a
   file, grep `[tether]`) whether the default path threads. If it does not, find which gate is
   false (feature-flag host blocked by egress is the prime suspect).
3. codex: run one `exec` and one `app-server` invocation; check codex logs for the websocket
   transport vs HTTPS fallback, and squid log for the upgrade.
4. grok, amp, agy: one run each; inspect request shape in squid log or CLI debug output for any
   incremental mechanism. Record the finding.

Exit: a short table in this file (per CLI: threaded yes/no, bytes up per run before/after, TTFT or
wall clock delta). If claude-code default is already threaded and codex already uses websockets,
skip to Phase 3.

### Phase 2: fix what Phase 1 finds blocked (only if it does)

- Flag fetch blocked by egress: add the flag host to the claude-code adapter's
  `defaultEgressDomains` (one line, plus the egress allowlist tests in `squid-config.test.ts`).
  Preferred over forcing `CLAUDE_CODE_TETHER_LIVE=1`, which depends on a volatile internal name.
- Codex websocket refused by squid: fix the squid config for the upgrade, or add the websocket
  host to codex's `defaultEgressDomains`.
- Do NOT set `CLAUDE_CODE_TETHER_LIVE` in adapter code. If an operator wants to force it, it goes in
  that provider's envVars, documented as volatile.

### Phase 3: pin the conditions (small PR)

- Unit test on `ClaudeCodeAdapter.buildCliInvocation`: the default env contains neither
  `ANTHROPIC_BASE_URL` nor `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, and egress domains include
  whatever Phase 2 added. Failure message names this plan.
- Same for codex: no override disabling `responses_websockets` in `execBaseArgs`/app-server args.
- A short section in `docs/architecture/cli-adapters.md`: threads are a latency and bandwidth
  lever owned by the binary; what turns them off; that they change no token figure, so
  `token_usage`, spend and context badges need no change.

### Not doing

- Implementing threads in Haive code: Haive has no Messages API loop of its own.
- Recording "threaded" per invocation: neither `claude-stream-json` nor codex's events report it;
  inferring it from debug logs would key on ephemeral wording.
- Cross-invocation threads (one thread across steps): each step is a new process with its own
  system prompt and tools, and a changed `system` or `tools` requires a new thread anyway.

## 6. Adversarial checks done

- "Threads save tokens?" Checked the docs pricing section and the launch blog: both say no.
- "Is Claude Code really using it, or only the article claims so?" Read the shipped binary:
  beta string, create/continue/replay logic and gates are present in 2.1.322.
- "Does Haive set something that disables it?" Grepped worker and shared for every gate variable;
  only the non-Anthropic wrappers set `ANTHROPIC_BASE_URL`, which is correct.
- Open: the sandbox image's claude and codex versions may differ from the host binaries read here;
  Phase 1 runs inside the sandbox for that reason.

## Sources

- https://platform.claude.com/docs/en/build-with-claude/message-threads
- https://claude.com/blog/message-threads
- https://developers.openai.com/api/docs/guides/websocket-mode
- https://openai.com/index/speeding-up-agentic-workflows-with-websockets
