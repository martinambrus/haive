# Serena LSP bridge for CLIs without LSP

> **Not started** 2026-11-27: this file holds findings and phases only. Nothing is approved and nothing
> is filed on the board. Every Haive claim was read on `main` `4b814ff5f` on 2026-11-27. Line numbers
> are hints and drift, so resolve each reference by its symbol. Keep this file current by editing the
> section a change belongs to. Order: P0 spike first; P1 onward only if P0 passes. If P0 fails on
> its first or second check, use the fallback in Decision instead.

## Context

The user asked whether an MCP-to-LSP bridge could give LSP tools to the CLIs that lack them, or
replace Haive's LSP setup entirely. The owner's rule: if the CLIs that support LSP share one
implementation and need nothing excessive to set up, keep it, and use a bridge only for the rest.

## Haive today

- Language-server binaries are installed once per sandbox image by `buildLspLayer`
  (`worker/src/sandbox/lsp-layer.ts`): intelephense, vtsls, pyright, gopls, rust-analyzer,
  solargraph, jdtls. The binaries are shared by every CLI.
- The model-facing bridge is a single function, `buildLspMarketplaceCommands`
  (`worker/src/cli-adapters/_lsp-marketplace.ts`). It installs Claude Code LSP plugins from
  `Piebald-AI/claude-code-lsps`, plus the local `drupal-php-lsp` plugin. All six claude-binary
  adapters call it: claude-code, zai, ollama, muse, grok, openrouter.
- `supportsLsp: false` in `shared/src/cli-providers/catalog.ts` for codex, gemini, antigravity
  and amp. All except amp have `supportsMcp: true`.
- Per-CLI MCP config already exists (`buildMcpConfigForCli`, `worker/src/sandbox/mcp-config.ts`):
  codex TOML at `~/.codex/config.toml`, gemini `~/.gemini/settings.json`, agy by bind mount.
  `buildDefaultMcpServers` is where a default server is declared.
- The pinned, prebuilt Python MCP server pattern already exists: `worker/src/sandbox/git-mcp-pin.ts`
  (`sandbox-image/git-mcp-requirements.txt` plus an install script, digest in the layer, image
  label `haive.git-mcp`, server declared only for an image that carries the label).

Conclusion: the Claude family meets the owner's rule, so keep the plugin path. A bridge is only
for codex, gemini and antigravity. Amp has no MCP support, so a bridge cannot help it.

Native support check (web, 2026-11-27): Codex CLI had no built-in LSP as of v0.125 (issue #8745
proposes it). The Gemini CLI changelog through v0.54 (2026-08-06) shows no LSP entry. Re-check both
before P1. If either ships native LSP, give that CLI the native path, not the bridge.

## Candidates

All numbers come from the GitHub API on 2026-11-27.

| Project | Last commit | Stars | License | Verdict |
|---|---|---|---|---|
| ktnyt/cclsp | 2026-02-22 | 675 | MIT | Fallback only. Active development stopped (issue #40, `wontfix`): the author points to Claude Code plugins, which do not help non-Claude CLIs |
| isaacphi/mcp-language-server | 2025-06-03 | 1.6k | BSD-3 | Rejected: dead, one release (v0.1.1, 2025-05) |
| YZTangent/lsmcp | 2025-12-31 | 0 | none | Rejected |
| oraios/serena | 2026-11-24, v2.1.0 (2026-10-19) | 31.7k | GPL-3.0 app, MIT `solidlsp` | Chosen |

cclsp details, kept in case of fallback:
- Node stdio server, configured by `cclsp.json` (`CCLSP_CONFIG_PATH`).
- Starts each server from a `command` array, so it can reuse the `buildLspLayer` binaries.
- Tools: `find_definition`, `find_references`, `rename_symbol`, `rename_symbol_strict`,
  `get_diagnostics`, `restart_server`.
- The rename tools write files and `.bak` copies.
- Starts every configured server at launch (issue #36).
- One `rootDir` per server.

## Decision

Use Serena, in read-only mode, as the LSP bridge for codex, gemini and antigravity. The deciding
factor is maintenance: the bridge sits in every run of those CLIs, and Serena is the only candidate
under active development.

Facts behind the choice:
- Serena has a `read_only: true` project setting (its changelog records fix #1938, which applies it
  to the base tool set) and `excluded_tools`.
- It covers 40+ languages, with these capabilities: find symbol, symbol overview, references,
  declaration, implementations and diagnostics.
- Runtime is Python 3.13 via uv, the same shape as the baked git MCP server.

GPL-3.0: Haive runs Serena unmodified as a separate process and links nothing, but an image that
contains it redistributes it. Ship its license notice and a pointer to the source with the image.

Fallback, if P0 fails check 1 or 2: cclsp pinned to a commit, or forked (MIT, small), with
`rename_symbol` and `rename_symbol_strict` turned off.

## Phases

### P0 spike (no Haive code)

Run Serena by hand in a sandbox image that has the `buildLspLayer` binaries, against one
TypeScript repo and one PHP repo, driven by codex and gemini. Pass all of:

1. Binaries: Serena uses the preinstalled `/usr/local/bin` servers and downloads nothing at
   startup or first use with egress closed. If it downloads servers itself, find the setting that
   points it at given paths. If there is none, P0 fails.
2. Repo writes: nothing appears in `git status` of the repo after a session. Serena keeps
   `.serena/` (project.yml, memories) inside the project by default; it must be configurable to
   a path outside the repo, or under a path the sandbox already masks
   (`docs/architecture/sandbox-masking.md`). If neither works, P0 fails.
3. Read-only: with `read_only: true` plus `excluded_tools`, the tool list in the CLI's init or
   `tools/list` holds no edit, shell or memory-write tool. Record the exact tool names.
4. Side behaviour: the web dashboard, onboarding prompt, memories and injected system
   instructions can all be turned off. Record the flags or contexts used (check whether a
   `codex` context exists).
5. Cost: resident RAM of Serena plus its servers per sandbox, measured for TS alone and for
   TS + PHP. Compare with the budget in `docs/architecture/runtime-capacity.md`.
6. Latency: time to the first `find_symbol` answer on a cold start.

Record results in this file under P0 results.

### P1 pinned install layer

- Add `serena-mcp-pin.ts` beside `git-mcp-pin.ts`, built the same way: a hashed requirements
  lock and install script under `sandbox-image/`, a venv at a versioned `/opt` path, an image
  label, and a test that the version constant equals the lock.
- Install only when the repo has LSP servers selected and a non-LSP, MCP-capable CLI is enabled,
  so Claude-only installs carry no extra weight. Check `docs/architecture/sandbox.md` for how
  layers join the composed image tag.
- Verify: image build test, label present, no network fetch on server start.

### P2 MCP wiring

- Declare the server in `buildDefaultMcpServers` only when all of these hold: the image carries
  the label, the CLI has `supportsMcp` and no Claude plugin bridge, and the task has configured
  LSP languages (`worker/src/lsp/configured-lsp.ts`).
- Render it through the existing codex TOML, gemini JSON and agy paths in `buildMcpConfigForCli`.
- Verify: per-CLI config snapshot tests. A live run on each of codex, gemini and agy lists the
  read-only tools.

### P3 capability flag split

- `supportsLsp` currently means two things. One is "the model has LSP tools". The other is
  Claude-plugin-specific behaviour: the dispatcher's agent-persona path gate
  (`orchestrator/dispatcher.ts`, the `!adapter.supportsLsp` check near the markdown
  `projectAgentsDir` test) and `buildPluginInstallCommands`.
- Do not flip the boolean for codex, gemini or agy. Replace it with a bridge kind, for example
  `lspBridge: 'claude-plugin' | 'serena-mcp' | null`. Then update every reader by its caller
  contract: the catalog, the adapters, the dispatcher, `configured-lsp.ts`, the web provider UI,
  and the catalog tests.
- Verify: grep finds no remaining `supportsLsp` reader. Existing LSP tests stay green.

### P4 prompts and verification

- The retrieval guidance names Claude's LSP operations generically
  (`step-engine/steps/_retrieval-guidance.ts`, `RETRIEVAL_GUIDANCE_WITH_LSP`). Add a Serena variant
  that names Serena's tool names as recorded in P0, so no prompt names a tool the CLI lacks
  (`docs/architecture/retrieval-protocol.md`).
- Extend the LSP readiness and verification path (`lspDispatchState`, `01b1-verify-composed-lsp`,
  `worker/src/lsp/final-verification.ts`) to probe the Serena bridge, not the plugin.
- Verify: unit tests for the prompt variant per bridge. One real codex task uses an LSP tool, as
  seen in its tool usage.

## Rollback

Each phase is additive and gated:
- P1 adds an image layer that no server spec uses until P2.
- P2's server spec is gated on the image label, so removing the spec (or the layer) brings back
  today's behaviour without a data change.
- P3 is a type-level rename and stays reversible while no persisted data holds the new field. Keep
  it in code only, not in a DB column.

No migration is planned. If one becomes necessary, write its rollback first.

## Not adopted

- Replacing the Claude plugin path with Serena. The plugin path is one function across six
  adapters and meets the owner's rule.
- Serena's JetBrains backend (paid) and its editing tools. Haive's CLIs edit through their own
  tools, and Haive's review and fix loop assume that.
- mcp-language-server and lsmcp. See Candidates.

## P0 results

Not run.
