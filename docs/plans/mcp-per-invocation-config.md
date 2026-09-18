# Per-invocation MCP configuration

> **Not started — and BLOCKED: the cheap mechanism this plan assumed does not exist.** Planned
> 2026-09-18 against `main` at `54bca265`; the levers were re-probed exhaustively the same day and
> every one of them is closed except home relocation, which is destructive. Read "The levers, as
> finally measured" before anything else here — the Decisions below are preserved as written so the
> reasoning is auditable, but Decision 1's mechanism is REFUTED and Decision 2's cost is now the
> only route rather than a caveat on a cheaper one.
>
> This plan still exists for a good reason: the alternative on the table was a choice between two
> wrong behaviours (see "Why not either half-measure"), and that analysis is unaffected. What is
> unresolved is the mechanism, and therefore whether the work is worth its cost at all.

## Context

For **gemini, codex and grok** the MCP config is written INTO the per-task auth volume
(`volume-merge` / `cli-merge` in `sandbox/mcp-config.ts`), because the path nests inside the auth
mount and bind-mounting over it is destructive in two ways at once — Docker materialises the missing
target inside the volume as a root-owned stub that outlives the container, and the mount hides
whatever else the file held. Only the claude family's `bind` delivery is per-invocation.

`exec-core` resolves and writes that config immediately before starting each container
(`exec-core.ts:438`), so the effective rule is **"last writer before container start wins"** for
every pair of concurrent invocations in one task — not merely for the step-summary pass.

**antigravity was a fourth until #164.** It moved to `bind` once agy's real read path was measured to
sit OUTSIDE its auth mount, which also fixed a total outage: Haive had been writing its config to
`~/.gemini/antigravity-cli/mcp_config.json`, which agy never reads. That fix is the proof that the
delivery taxonomy is right and the classifications were what drifted.

Two consequences today, both real:

- **A `toolProfile: 'none'` invocation cannot be isolated, and clearing is destructive.**
  `resolvers.ts:266-269` calls `clearVolumeBackedMcp`, which erases the shared file — belonging to
  whatever step is running concurrently. The step-summary pass is excluded by PURPOSE at
  `exec-core.ts:437` rather than by declaring the profile, precisely to dodge that.
- **The window is not small.** The npm pre-warm sits between the config write and container start
  and can run to a 240s budget, so "clear it and let the next invocation re-apply" is not a repair.

Per-scope serialization (`37231660`) removed interleaved writes but cannot choose the ORDER.

## The levers, MEASURED 2026-09-18

| Provider | Delivery | Per-invocation lever |
|---|---|---|
| claude-code, zai, ollama, muse, openrouter | `bind` | already per-invocation |
| antigravity | `bind` (since #164) | already per-invocation |
| **codex** | `cli-merge` | **`CODEX_HOME`** — `codex doctor` with it set reports `config.toml /tmp/config.toml`, `✓ config loaded` and `configuration scope: invocation config` |
| **grok** | `cli-merge` | **`GROK_HOME`** — `grok inspect` prints `User: /root/.grok/config.toml` by default and `User: (none)` with it set; `XDG_CONFIG_HOME` is ignored |
| gemini | `volume-merge` | **unmeasurable here** — no sandbox image and no `cli_providers` row exist on this install |

## The levers, as finally measured

Re-probed 2026-09-18 against the live binaries. **Everything except home relocation is closed**, and
the table above should be read through this one:

| Lever | Verdict |
|---|---|
| `-c mcp_servers={}` | **MERGES — cannot narrow.** A `config.toml` holding `[mcp_servers.fromfile]` still reports `MCP servers 1` under the empty override |
| `-c mcp_servers={other={…}}` | **MERGES.** File's server plus the override's gives `MCP servers 2` |
| `-p/--profile <name>` | **MERGES.** `codex mcp list -p narrow` lists the base file's server AND the profile's. (`--profile` is rejected by `codex doctor` — it applies only to runtime commands and `codex mcp`, so probe it through one of those) |
| `--tools` / `--disallowed-tools` | **grok only, and "Built-in tools" only** per its own help, so neither reaches MCP servers. codex has neither flag |
| codex feature flags | 140 of them; **none gates MCP loading** (`enable_mcp_apps`, `mcp_2026_07_28`, `non_prefixed_mcp_tool_names` are unrelated) |
| grok config override | **none exists.** Its `-c` is `--continue`; full flag list enumerated |
| `CODEX_HOME` / `GROK_HOME` | **the only thing that works** — and it relocates the whole state tree, see Decision 2 |

An earlier revision of this plan named `-c mcp_servers={}` as "a guess" and the config-home variable
as the answer. Both judgements were wrong in the same way: the argv override was first tested
against an EMPTY home, where an override can only ever demonstrate ADDITION. The experiment that
mattered was against a POPULATED file, and it shows the override unions rather than replaces.

**So there is no cheap per-invocation mechanism on either provider.** What remains is home
relocation, whose cost Decision 2 describes and which the volume inspection argues against: a codex
task volume holds `auth.json`, `config.toml` AND five live SQLite databases with `-wal`/`-shm`
sidecars, `thread_history_1.sqlite`, `thread-writer-locks/`, `session_index.jsonl`, `sessions/`,
`shell_snapshots/` and `installation_id`. A fresh home gives an invocation none of that state, and
copying it means cloning hot SQLite while a sibling invocation may be mid-write. grok is the same
shape, with `.lock` files that say concurrent access to that home is expected.

## THE CONSTRAINT THAT SHAPES EVERYTHING

Narrowing an invocation's MCP surface has already been fatal once, and the trigger is **still live**.

MEASURED 2026-09-13 on muse (api.meta.ai), recorded at `step-definition.ts:91-98` and in
`mcp-none.test.ts:18-23`: `01-env-detect` runs with `disableTools`, so `--tools ''` strips the
built-in `tool_search`, while the MCP surface it was handed anyway supplied tools the binary DEFERS
when `ENABLE_TOOL_SEARCH` is set. The endpoint answered `400 Deferred tools require
tools.tool_search` and onboarding died 20s into step 1 on every repo. `--tools ''` alone, effort
`xhigh`, and `ENABLE_TOOL_SEARCH` alone all succeed — only the pairing kills it.

**Still live, verified 2026-09-18:** `muse` is enabled and carries `"ENABLE_TOOL_SEARCH": "true"` in
`cli_providers.env_vars`. It is one of only two provider rows with any `env_vars` at all.

**Blast radius:** `supportsDisableTools = true` on `claude-code`, `zai`, `ollama`, `muse`,
`openrouter` and `grok`; default `false`, and codex/gemini/amp/antigravity ignore the flag outright.
So every provider that can reach the pairing is a claude-binary wrapper or grok — and **grok is also
one of the two providers this plan changes**, which is why the invariant below is a gate on the work
rather than a footnote to it.

The safety condition is already written down, as a biconditional, in
`step-runner-step-summary.test.ts:238-240`: `--tools ''` "is safe **precisely because** no MCP is
wired."

> **INVARIANT.** A narrowed surface must be either fully EMPTY or accompanied by the built-in tool
> that resolves deferred definitions. A partially narrowed surface handed to a `disableTools`
> invocation on a deferring endpoint is the measured 400.

Follow the existing precedent rather than inventing one: `dispatcher.ts:355` computes
`noBuiltInTools: req.invokeOpts?.disableTools === true && adapter.supportsDisableTools === true` —
ANDed with the adapter because claiming "no search, no file reading, no shell" to one that ignores
the flag "tells an agent that still has all three". Every new narrowing claim gets the same
treatment: **never assert a narrowing the adapter cannot keep.**

A second measured hazard belongs to the same family. `mcp-surface.ts:389`'s `noBuiltInTools` branch
exists because the grep/ripgrep fallback advice "would send it after something it cannot run" —
MEASURED, glm-5.3 followed it on two repos and answered with prose plus a `cat
wp-includes/version.php` block instead of the required JSON, three attempts each, until the retry
budget was spent, "which is what made it look like a model fault". So the prompt and the wired
surface must move together, always.

## Why not either half-measure

- **Keep clearing** (today): a narrowed run erases a live step's MCP surface mid-task.
- **Stop clearing**: nothing is destroyed, but the `none` prompt then misstates the tools the run
  actually holds — and per `mcp-surface.ts:389` that specific mismatch has already cost a retry
  budget. It also does not make isolation possible; it only makes the failure quieter.

Neither is a fix. With per-invocation config the question dissolves: `none` writes an EMPTY
per-invocation config, exactly as `bind` already does, and clears nothing shared.

## Decisions

1. ~~**Per-invocation config for codex and grok via their config-home env var.** Not argv
   suppression — probed and rejected.~~ **REFUTED — see "The levers, as finally measured".** The
   config-home variable is the only mechanism that works, and argv suppression was rejected on a
   flawed experiment; re-probed, the argv route merges rather than replaces, so it cannot narrow a
   surface either. Both halves of this decision were wrong. Whether to accept home relocation's
   cost, re-scope to stopping the destructive clear, or shelve the work is an open decision, not
   something this plan should presume.
2. **The per-invocation home must be SEEDED with auth**, because the credentials live under the same
   root (`codex doctor` reports config.toml, sqlite home and every state DB under `CODEX_HOME`;
   `catalog.ts` lists `authConfigPaths: ['~/.codex']`). `task-auth-volume.ts:485-497` performs the
   existing copy by running a HELPER CONTAINER (`cp -a /src/. /dst/`) wrapped in
   fingerprint-before-copy logic that exists to avoid recording a stale credential hash. A third
   per-invocation layer therefore costs **one helper container per invocation**, inside the module
   whose entire subject is credential lifetime. Measure that cost before committing to it; a
   narrower seed (the credential file alone rather than `cp -a` of the tree) is the first thing to
   try.
3. **gemini is explicitly OUT OF SCOPE**, not silently skipped: it cannot be verified on this
   install. Say so in the code and leave it on `volume-merge`.
4. **The env channel has to be widened.** There is none per-invocation today: every
   `envInjection()` implementation takes `(_provider)` alone, while `InvokeOpts.extraEnv` exists at
   `cli-adapters/types.ts:34` and `buildShellEnv(provider, secrets, extraEnv)` already threads a
   map. That is the seam to extend.
5. **Preserve the ordering constraint.** `resolveAuthMounts` must run BEFORE
   `resolveMcpExtraFiles` — stated identically at both `sub-agent.ts` callers (`:59`, `:134`):
   reversed, "the merge finds no volume and the agent silently runs with no MCP servers at all."
   A per-invocation home inserts a third step into exactly that sequence.
6. **All three resolver callers must change together**: `exec-core.ts:438`, `sub-agent.ts:63` and
   `sub-agent.ts:138`. The `none` branch was deliberately put INSIDE the resolver because those
   three had already diverged on `toolProfile` once; a per-invocation home added at one caller
   reintroduces that bug.
7. **Kill switch**, defaulting OFF for this one, unlike the usual default-on: it changes credential
   plumbing on live task tooling, so the first release should be opt-in per install.

## Verification

1. **Extend `mcp-none.test.ts`** rather than adding a file — it already mocks the three volume
   writers, documents the muse 400 in its header, and pins `emptyMcpSurface()`, the db-free `none`
   early-out and `01-env-detect`'s paired declaration. New cases: a per-invocation home is passed
   for codex and grok; `none` writes an empty per-invocation config and calls no volume writer;
   gemini still takes `volume-merge`.
2. **The muse case is the gate.** A `disableTools` invocation on a provider carrying
   `ENABLE_TOOL_SEARCH` must still receive a fully empty surface. Assert the pairing, not just the
   profile.
3. **Concurrency test**: two invocations in one task with different profiles must each see their own
   config. That is the defect this plan exists for and nothing pins it today.
4. **Live check** on the dev install with codex and grok: a mining fan-out plus a step-summary pass
   concurrently, verifying each invocation's own config and that credentials still work in both.
5. `pnpm typecheck`, worker and shared suites, and the fs ratchet unchanged.

## Rollback

Switch-gated and additive: off restores volume-backed delivery for codex and grok, which is today's
behaviour. No schema change. The seeding layer must be removable without touching the existing
user→task copy, so build it beside that path rather than inside it.

## Out of scope

- **gemini**, until an image and a provider row exist to measure against.
- **Retiring `volume-write`.** It has had no producer since #164 moved antigravity to `bind`. The
  mode and `writeMcpFileIntoTaskVolume` are correct and tested, and a CLI whose MCP file genuinely
  nests inside its auth mount would need them again. Its own change.
- **`mcp-none.test.ts` calls `resolveMcpExtraFiles` with 7 of its 9 arguments** (lines 39 and 66).
  The worker tsconfig excludes `**/*.test.ts`, so CI has never typechecked it and vitest transpiles
  without typechecking. Latent, pre-existing, and its own change — but fix it before adding cases to
  that file, or the new ones inherit the same silence.
