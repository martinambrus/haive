# Plan: Gemini BYOK-only + Antigravity CLI adapter

Status: PROPOSED (not yet implemented). Audience: an engineer or AI agent implementing the change in this Haive repo.

## Why

Google announced on May 19, 2026 that Gemini CLI will stop serving requests for free, Google AI Pro, and Google AI Ultra consumer users on June 18, 2026. Gemini CLI remains available for paid Gemini/API-key and enterprise Gemini Code Assist paths. Google is steering consumer/subscription CLI usage to Antigravity CLI.

Consequences for Haive:

1. The existing `gemini` provider must become API-key/BYOK only. Haive currently defaults Gemini to `subscription`; that path must disappear from the UI and be rejected by the API.
2. A new `antigravity` provider can restore Google subscription-style CLI usage only if Antigravity's authentication model can be persisted into Haive's sandbox model.
3. If Antigravity is exposed with consumer Google sign-in, the web UI must show a prominent data-retention/training warning before save.

Official sources checked:

- Google Developers Blog announcement: https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Antigravity CLI product page: https://www.antigravity.google/product/antigravity-cli
- Antigravity CLI install/auth docs: https://antigravity.google/docs/cli-install and https://www.antigravity.google/docs/cli-getting-started
- Antigravity settings docs: https://antigravity.google/docs/cli-settings
- Antigravity plugins/skills/MCP docs: https://antigravity.google/docs/cli-plugins
- Antigravity subagents docs: https://antigravity.google/docs/cli-subagents

These official docs confirm the `agy` binary, the Mac/Linux install script, secure OS keyring authentication, `~/.gemini/antigravity-cli/settings.json`, global MCP at `~/.gemini/antigravity-cli/mcp_config.json`, workspace MCP at `.agents/mcp_config.json`, global skills at `~/.gemini/antigravity-cli/skills`, workspace skills at `.agents/skills`, plugins under `~/.gemini/antigravity-cli/plugins`, and subagent support. Still verify command flags and credential persistence with a real `agy` binary before coding Part B.

## Critical Gate: Antigravity Auth Feasibility

### Gate result: PASS (verified 2026-06-04 on real `agy` 1.0.5, headless Linux container)

Subscription auth is feasible with Haive's existing file-copy auth-volume model. Evidence and confirmed values:

- Credentials are a copyable FILE: `~/.gemini/antigravity-cli/antigravity-oauth-token` (JSON: `access_token` + `refresh_token` + `expiry`, mode 0600). NO OS keyring was used — the test container had no Secret Service and `DBUS_SESSION_BUS_ADDRESS` unset, yet auth worked. Copy-replay confirmed: copying ONLY that file into a second clean container and running `agy -p` authenticated off the refresh token (`pong`, no re-login).
- Binary `agy`; install = `curl -fsSL https://antigravity.google/cli/install.sh | bash` → single native glibc binary at `$HOME/.local/bin/agy`, sha512-verified from a manifest.
- Headless login: running `agy` with no creds prints a Google OAuth URL with prefix `https://accounts.google.com/o/oauth2/` (identical to the existing `AUTH_URL_PREFIXES.gemini`) and accepts a pasted authorization code on stdin; the redirect is a hosted page (`antigravity.google/oauth-callback`), so no container loopback is needed. This matches the existing `cli-login-banner` URL+paste flow.
- Non-interactive prompt = `agy -p "<prompt>"`; `--dangerously-skip-permissions` exists.
- MCP uses separate sparse files (`~/.gemini/antigravity-cli/mcp_config.json` global, `.agents/mcp_config.json` workspace) — bind-mount, NOT a settings.json merge (confirms B5's primary path).
- BYOK is heavy: the binary embeds `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` (GCP ADC / service-account), NOT a simple `GEMINI_API_KEY`/`GOOGLE_API_KEY`. So the first pass is subscription-only (`apiKeyEnvName: null`); an ADC/service-account api_key mode can come later.

First-pass config decisions from this result:

- `defaultAuthMode: 'subscription'`, `supportsCliAuth: true`, `apiKeyEnvName: null`.
- `authConfigPaths: ['~/.gemini/antigravity-cli']`. Caveat: that dir also accumulates large runtime files (a ~17MB `webm_encoder`, a conversations SQLite DB, logs) that the per-task volume copy will carry. Acceptable for v1; a later optimization is to capture just the token file content into an encrypted `cli_provider_secrets` row (like claude-code's `CLAUDE_CODE_OAUTH_TOKEN`) and materialize it at task start.
- `supportsSubagents: false` (set in BOTH adapter and catalog). Antigravity's subagents are plugin-packaged and do not map to Haive's claude-style native `Task()` path; sequential emulation is correct until proven otherwise.
- `rulesFile: 'AGENTS.md'`, `rulesFileMode: 'native'` (docs indicate AGENTS.md; runtime-confirm rules loading later).
- Still to confirm at leisure (non-blocking): default model name (`agy models`) and the exact auto-update-disable env var.

Original gate procedure (kept for reference / re-verification):

Do this before adding `antigravity` to the selectable provider catalog.

Haive's current auth model copies files and directories between Docker volumes. See:

- `packages/worker/src/sandbox/task-auth-volume.ts`
- `packages/worker/src/sandbox/cli-auth-volume.ts`
- `packages/api/src/routes/cli-login-banner.ts`

The Antigravity docs say `agy` uses the OS secure keyring/Secret Service for authentication. That is not automatically captured by Haive's file-copy auth volumes. Therefore subscription auth is blocked until proven restorable.

Run a real Linux/headless `agy` experiment:

1. Install `agy` in a clean container or VM.
2. Run the documented remote/SSH browser auth flow.
3. Inspect `$HOME`, `~/.gemini/antigravity-cli`, `~/.config`, Secret Service/libsecret/dbus state, and `agy` behavior after copying only normal files into a second clean container.
4. Run a non-interactive prompt/probe after the copy.

Decision:

- If `agy` writes a copyable credential file and a restored copy works: implement subscription login in B4.
- If credentials are keyring-only: do not expose `antigravity` as a subscription provider in the first pass. Either add it as API-key only if `agy` supports a documented env-var key/project auth mode, or defer the provider. Subscription support would need a separate design for persistent libsecret/gnome-keyring plus dbus/session bootstrap, not just `authConfigPaths`.
- If `agy` has no reliable non-interactive prompt/probe mode: defer runtime provider support even if the TUI works.

Default auth for `antigravity` is therefore conditional. Use `subscription` only if this gate proves Haive can persist and replay the auth state. Otherwise use `api_key` if supported, or leave Antigravity out of the catalog.

## Part A: Make Gemini BYOK-only

Goal: Gemini supports only `api_key` with `GEMINI_API_KEY`. Gemini login/subscription paths disappear from UI and API surfaces. Other providers keep their existing subscription behavior.

1. `packages/shared/src/cli-providers/catalog.ts`
   - Set the `gemini` entry to `defaultAuthMode: 'api_key'`. This is what removes the subscription option from the web form (the form gates that option on `defaultAuthMode !== 'api_key'`).
   - KEEP `supportsCliAuth: true`. Do NOT set it false. `supportsCliAuth` is NOT "supports subscription login" — it gates the dispatcher's CLI execution path (`dispatcher.ts` `tryBuildPlan` returns `null` when it is false), so setting it false makes gemini undispatchable (it can never run a step). zai is the precedent: api-key-only yet `supportsCliAuth: true`, with a comment explaining exactly this.
   - Keep `apiKeyEnvName: 'GEMINI_API_KEY'`.

2. `packages/worker/src/cli-adapters/gemini.ts`
   - Set `defaultAuthMode = 'api_key' as const`.
   - KEEP `supportsCliAuth = true` (see item 1; mirror zai's adapter comment). `assertUserAuthReady` short-circuits when `authMode === 'api_key'`, so keeping it true does not force a login.
   - Keep executable, `GEMINI_API_KEY`, `GEMINI.md`, and existing Gemini MCP behavior.

3. `packages/api/src/routes/cli-providers.ts`
   - Add server-side auth-mode validation on create and update. The current route accepts any enum value in `body.authMode`, so a stale or manual client can still create `gemini` with `subscription`.
   - Reject `subscription` when the selected provider's catalog metadata has `defaultAuthMode === 'api_key'` (the api-key-only providers: gemini, zai). This mirrors the form's subscription-option gating. Do NOT key this on `supportsCliAuth` (it is true for gemini/zai).
   - Reject `api_key` unless the selected provider has a non-null `apiKeyEnvName`.
   - On update, validate the requested `authMode` against the existing provider name.
   - Return HTTP 400 for unsupported auth modes.

4. `packages/worker/src/cli-adapters/auth-probe.ts`
   - Do not remove `gemini` from `isAuthProbeSupported`.
   - Keep the Gemini `buildAuthProbeCommand` case. The probe handler injects decrypted provider secrets into the probe env, so `gemini -p ...` validates `GEMINI_API_KEY` in BYOK mode. Removing it would downgrade Gemini "Test connection" to a version-only check.

5. Remove Gemini from subscription login surfaces:
   - `packages/worker/src/cli-adapters/setup-token-command.ts`: remove `gemini` support and the Gemini settings-seed case.
   - `packages/api/src/routes/cli-login-banner.ts`: remove `gemini` from `SUPPORTED_PROVIDERS`. Gemini-specific poller/parser code can stay if unreachable, or be deleted if tests are updated.
   - `packages/web/src/components/cli-provider-test.tsx`: remove `gemini` from `LOGIN_SUPPORTED`.
   - Reword the test help text so it no longer describes the probe set as "subscription-mode CLIs"; Gemini remains probe-supported in API-key mode.

6. `packages/worker/src/queues/cli-exec/exec-core.ts`
   - Update Gemini's auth-failure hint. It currently points users at `gemini auth login`; after this change it should tell users to configure or replace the `GEMINI_API_KEY` secret.
   - If Antigravity subscription auth is later implemented, add a separate Antigravity login hint instead of reusing the Gemini one.

Do not change:

- `cliAuthModeEnum`; `subscription` is still required for `claude-code`, `codex`, and `amp`.
- `mergeGeminiMcpIntoSettings`; Gemini still reads MCP from its settings file in API-key mode.
- Shared login/probe infrastructure except for Gemini-specific allowlists and copy.

Part A verification:

- Gemini form shows API-key auth only.
- API rejects `authMode: 'subscription'` for Gemini.
- Gemini "Log in" button is gone.
- Gemini "Test connection" still validates `GEMINI_API_KEY` through the auth probe and does not fall back to version-only.
- A Gemini task runs with `GEMINI_API_KEY`.
- Auth failures mention `GEMINI_API_KEY`, not `gemini auth login`.
- `claude-code`, `codex`, and `amp` still show subscription login.
- `pnpm typecheck` and relevant tests pass.

## Part B: Add `antigravity` Provider

Provider name: `antigravity`. Binary: `agy`, per official docs. Implementation depends on the auth gate above.

### Compile-forcing surfaces

Adding `'antigravity'` to `CliProviderName` will force these entries/cases:

- `packages/shared/src/cli-providers/catalog.ts`: `CLI_PROVIDER_CATALOG`.
- `packages/shared/src/cli-providers/install-metadata.ts`: `CLI_INSTALL_METADATA`.
- `packages/worker/src/sandbox/mcp-config.ts`: exhaustive `buildMcpConfigForCli` switch.
- `packages/worker/src/sub-agent-emulator/splitter.ts`: `buildSequentialForProvider` switch.

Also update `packages/worker/src/cli-adapters/index.ts` to export the adapter for the public adapter surface, even if the build does not force it.

### B1. Provider name, schema, and migration

- `packages/database/src/schema/cli-providers.ts`: add `'antigravity'` to `cliProviderNameEnum`.
- Generate and commit the next migration with `pnpm --filter @haive/database exec drizzle-kit generate`.
- Confirm the migration is additive: `ALTER TYPE "cli_provider_name" ADD VALUE 'antigravity';`. It should not recreate/swap the enum.
- The dev compose `db-migrate` service currently runs `pnpm --filter @haive/database push --force`, so local dev may apply schema through push. Still commit the generated SQL so deploy/review has the enum change explicitly.
- `packages/shared/src/schemas/cli-providers.ts`: add to the zod provider enum.
- `packages/shared/src/types/index.ts`: add to `CliProviderName`.
- `packages/web/src/lib/api-client.ts`: add to the web `CliProviderName`.

### B2. Adapter class

Create `packages/worker/src/cli-adapters/antigravity.ts` and register/export it:

- `packages/worker/src/cli-adapters/registry.ts`: import and `register(new AntigravityAdapter())`.
- `packages/worker/src/cli-adapters/index.ts`: export it.

Adapter fields:

- `providerName = 'antigravity'`.
- `defaultExecutable = 'agy'`.
- `supportsSubagents = true` if verified against runtime behavior; official docs say subagents exist.
- `supportsCliAuth = true` only if the auth gate proves subscription auth is restorable.
- `supportsMcp = true`; official docs show MCP support.
- `supportsPlugins = true`; official docs show plugins.
- `defaultAuthMode = 'subscription'` only if subscription auth is implemented. Otherwise use `api_key` if documented and supported, or do not expose the provider.
- `apiKeyEnvName`: set only after verifying the documented env var/project mode. Do not guess `GEMINI_API_KEY`.
- `defaultModel`: verify with docs or `agy --help`.
- `rulesFile = 'AGENTS.md'` and `rulesFileMode = 'native'` if verified. Antigravity migration docs indicate `AGENTS.md` compatibility; do not use `GEMINI.md` unless `agy` requires it.
- `buildCliInvocation()`: verify `agy -p "<prompt>"` and any non-interactive/output flags. Official docs/snippets show `agy -p`, but auth probe output and CI behavior still need a real run.
- `envInjection()`: include only documented noninteractive/trust/sandbox env or flags.

Keep adapter and catalog values consistent. The current Gemini catalog/adapter drift on `supportsSubagents`; avoid repeating that for Antigravity because the create route persists catalog metadata while runtime uses adapter metadata.

### B3. Catalog and install metadata

`packages/shared/src/cli-providers/catalog.ts`:

- Add display metadata (`displayName: 'Google Antigravity'`, docs URL, description).
- Set auth fields according to the auth gate.
- `authConfigPaths`: include `~/.gemini/antigravity-cli` for config/plugins/skills/MCP. This path alone does not prove auth persistence if credentials live only in the OS keyring.
- `projectSkillsDir: '.agents/skills'`.
- `userSkillsPaths`: use `~/.gemini/antigravity-cli/skills` as canonical. If backwards-compatible Gemini skills are needed, add `~/.gemini/skills` as a fallback only if the current `UserSkillPath` model can represent it cleanly, or extend that model intentionally.
- `supportsPlugins: true`.
- `supportsMcp: true`.
- `supportsSubagents`: match the adapter.
- `projectAgentsDir`: leave `null` unless official docs or a real run confirm a plain workspace directory for custom standalone agents. The docs confirm subagents and plugin-packaged agents, not necessarily a `.antigravity/agents` directory.
- `effortScale`: `null` unless `agy` exposes a documented reasoning-effort setting.

`packages/shared/src/cli-providers/install-metadata.ts`:

- Add `antigravity`.
- Official install: `install: { kind: 'curl-script', url: 'https://antigravity.google/cli/install.sh', binary: 'agy' }`.
- `versionPinnable: false` for curl-script unless Google publishes a pinning mechanism.
- `versionSource: { kind: 'none' }` unless an official releases endpoint is confirmed.
- `autoUpdateDisable`: docs mention `AGY_CLI_DISABLE_AUTO_UPDATE=true`; set that through the existing env-based knob if it works in generated images.

Installer caveat:

- `packages/worker/src/cli-versions/codegen.ts` already supports `curl-script`, but emits `RUN curl -fsSL <url> | bash`.
- Core sandbox images already have bash, but environment-template runtime-tool layers currently install curl/ca-certificates and may not install bash for Alpine-derived images. Before relying on the Antigravity curl installer, either add bash where `curl-script` installs are generated or add bash to `buildHaiveRuntimeToolsLayer` for the relevant package managers.

### B4. Auth and login

Only implement this section if the auth gate proves subscription auth can be saved and replayed. If credentials are keyring-only, do not add a fake file poller; defer subscription auth or design persistent keyring support separately.

- `packages/worker/src/cli-adapters/auth-probe.ts`
  - Add `antigravity` only after verifying a reliable non-interactive probe command.
  - Add provider-specific expired/missing-auth patterns.

- `packages/worker/src/cli-adapters/setup-token-command.ts`
  - Add `antigravity` only for subscription auth.
  - Use the real setup command (`agy` first-run or `agy login`) and documented headless env/flags.
  - Seed `~/.gemini/antigravity-cli/settings.json` only with safe preferences/noninteractive settings, not credentials.

- `packages/shared/src/cli-providers/auth-banner-parser.ts`
  - Add `AUTH_URL_PREFIXES.antigravity` based on the actual URL `agy` prints.
  - Add `extractAntigravityAuthUrl` only if generic URL extraction is not precise enough.
  - Add to `TOKEN_PASTE_PROVIDERS` if the remote/SSH flow requires pasting an authorization code back into the terminal.

- `packages/api/src/routes/cli-login-banner.ts`
  - Add `antigravity` to `SUPPORTED_PROVIDERS` only if subscription auth is implemented.
  - Add an Antigravity URL-extraction branch if needed.
  - Add `startAntigravityCredsPoller` only if there is a copyable credential file. The poller's `test -s` target must be the real file path from the auth gate.

- Auth volumes
  - `ensureTaskAuthVolumes`, `resolveTaskAuthMounts`, and `resolveCliAuthMounts` are catalog-path driven. They work only for files/directories under `authConfigPaths`; they do not capture Secret Service/keyring state.

- `packages/worker/src/queues/cli-exec/exec-core.ts`
  - Add a provider-specific Antigravity login hint only when subscription auth is implemented.

Optional polish:

- `packages/api/src/routes/terminal.ts` currently labels Google OAuth-looking URLs as Gemini. If users run `agy` manually in the terminal, update the parser/README only if the service label matters or `agy` URLs are distinguishable.

### B5. MCP

`packages/worker/src/sandbox/mcp-config.ts` must add an `antigravity` case.

Official Antigravity docs say MCP uses a separate sparse config file:

- Global: `~/.gemini/antigravity-cli/mcp_config.json`
- Workspace: `.agents/mcp_config.json`

Therefore the first implementation should return a normal JSON extra file:

- Path: `${targetHome}/.gemini/antigravity-cli/mcp_config.json`
- Format/content: `{ "mcpServers": ... }`
- No Gemini-style merge into `settings.json`.

Do not add Antigravity to the Gemini `mergeGeminiMcpIntoSettings` branch unless a real `agy` run proves the docs are wrong. The separate MCP file means the default bind-mount path in `resolveMcpExtraFiles` should be sufficient, with the existing Haive/user MCP merge behavior preserved.

### B6. Subagents

`packages/worker/src/sub-agent-emulator/splitter.ts` needs a `case 'antigravity'` in `buildSequentialForProvider` even if Antigravity supports native subagents. The switch has no default and must return `SubAgentInvocation`.

Use an existing sequential strategy such as the Codex/Gemini style for the compile-only fallback. At runtime it is used only when `adapter.supportsSubagents === false`.

### B7. Web warning

`packages/web/src/components/cli-provider-form.tsx`:

- When selected provider is `antigravity` and `authMode === 'subscription'`, show a prominent warning before save.
- Copy should be factual: consumer Google sign-in may allow prompts/code to be retained or used to train Google models; use API-key/GCP-project auth if available to avoid consumer terms.
- Link to Google's applicable terms/privacy docs.
- If Antigravity ships API-key only in the first pass, do not show the consumer subscription warning for API-key mode.

### B8. Tests

Add focused tests where the repo already has coverage patterns:

- API route tests for provider/auth-mode validation, especially Gemini rejecting `subscription`.
- Gemini auth-failure hint test if `exec-core` has or can accept focused coverage.
- Adapter invocation/env test for Antigravity if the adapter is added.
- Auth-probe/setup-token tests for Antigravity only if subscription auth is implemented.
- MCP config test for Antigravity's `mcp_config.json`.
- Install codegen/runtime-tool-layer test if bash handling changes.
- `auth-banner-parser` and terminal parser tests if Antigravity login URL handling is added.
- Existing/e2e CLI provider tests should cover creation and form behavior.

## Rollout and Verification

- `pnpm typecheck`, `pnpm build`, and relevant tests pass.
- DB migration is committed and additive. Local dev may use the existing compose `db-migrate` push path, but review/deploy must still include the generated SQL.
- Boot stack with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build` and confirm api/worker/web health.
- Gemini:
  - UI offers API-key only.
  - API rejects subscription mode.
  - Test connection validates `GEMINI_API_KEY`.
  - Task execution works.
  - Auth failure copy points to the API key secret.
- Antigravity:
  - Start with the auth gate result.
  - If subscription auth is blocked by keyring-only storage, document that and do not expose subscription mode.
  - If subscription auth is implemented, verify login end-to-end in a sandbox, confirm restored credentials work in a second task container, confirm the warning appears, and confirm MCP servers are visible to `agy`.
  - If API-key mode is implemented instead, verify the env/project auth path and do not show the consumer subscription warning.

## Sequencing

1. Run the Antigravity auth feasibility gate.
2. Implement Part A and commit it separately.
3. If the gate passes, implement Antigravity enum/types/adapter/catalog/install/MCP.
4. Implement Antigravity auth/login only for a proven restorable auth mode.
5. Add the web warning and tests.
6. Run rollout verification.

## Out of Scope

- Backward-compatible migration for existing Gemini subscription rows; the product has no users yet.
- Enterprise Gemini Code Assist licensing paths.
- Full Antigravity plugin-management UI beyond exposing provider metadata and preserving file paths.
