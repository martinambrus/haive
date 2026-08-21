# Onboarding Scope + LSP + Onboarding-Mirror + Retrieval Refactor

Status: IN PROGRESS. SLICE 1 COMPLETE + COMMITTED/PUSHED (7272078 main). SLICE 2 COMPLETE + COMMITTED/PUSHED (e0bee51 main; 2A-2F + cli-exec follow-up, unit/tsc verified, NOT live-e2e): repo-level persistence refactor — onboarding_environment/onboarding_tooling jsonb cols + .haive-data/ committed mirror (environment/tooling/exclusions), written at 12-post-onboarding, imported non-clobbering in persistDetection; consumers (loadRepoStackAnchors, resolveRagSyncPrefs, declare-deps, cli-exec resolveRagMcpConfig + loadUserMcpServers) read col-first + fallback. Next: commit slice 2 (pending user), then Slice 3 (LSP compose layer) OR Slice 4.
Owner context: Drupal 11 onboarding took ~3h on a 7-module repo because the expensive
agentic mining steps crawl the WHOLE repo (vendor, core, contrib). This refactor scopes
them to custom code, fixes LSP so tasks can use installed language servers, syncs
onboarding state across machines, and fixes retrieval to combine RAG/KB with LSP/grep.

## Problem (verified)
- The expensive steps hand the repo to a CLI told "deeply explore this repository" with no
  scope. IGNORE_DIRS only filters a 150-file orientation tree, NOT the agent's own reads.
- vendor is excluded from trees everywhere; Drupal core/contrib are NOT (and FRAMEWORK_PATTERNS
  are top-level, so `core/`/`modules/contrib/` never match a `web/`-docroot or nonstandard layout).
- Per-repo `excludedPaths`/`selectedPaths` columns + repos-page UI are DEAD (written at clone,
  displayed/editable, never read by any scan/mine/index step).
- LSP binaries are installed in the env-template image but LSP isn't a compose layer and the
  php plugin maps to a server we don't ship. Non-Claude CLIs have no LSP path.
- Onboarded status = 4 on-disk markers, no DB flag → a repo onboarded elsewhere clones as
  "onboarded" but this machine's DB lacks php/db versions, tooling choices, exclusions.
- Retrieval is a strict RAG→KB→grep fallback in prompt text only; LSP not wired; no combine.

## Locked decisions
1. ONE per-repo deny list, gitignore-style globs, DENYLIST semantics: tree node ticked=included,
   unticked=denied; STORED value = the deny set; a path NOT in the tree (new folder from a future
   task) defaults INCLUDED (this is what makes task-end auto-add new features). Root checkbox =
   select-all/deselect-all.
2. Seed the deny list from an LLM light structure-detect (reads composer.json installer-paths /
   drupal-scaffold + repo .gitignore + shallow dir listing). Generalizes across frameworks;
   deterministic patterns alone fail for nonstandard/web-docroot layouts.
3. Agents step (06_5) STAYS full-repo, unscoped (it's a single-shot LLM call, requiredCapabilities:[],
   cheap; needs framework/php/db/legacy signals). Scope picker goes AFTER 06_5, BEFORE 08.
   Picker's detect runs the structure-detect; needs 01/01_5 (cheap deterministic scan) done first.
4. Deny list consumed by: 08 KB, 09-qa/09_1/09_2, 09_5 skills, 01_5 ripgrep predicate, 09_7/10 RAG,
   02-pre-rag-sync, 11c task-end RAG. NOT consumed by 06_5 agents.
5. Task-end KB LEARNING (11-phase-8-learning) is task-history-scoped → NO deny list. Task-end RAG
   (11c) walks worktree code → APPLIES the deny list. Two different consumers; keep straight.
6. Mining scope is SOFT (prompt: "focus mining on these dirs; step outside only to resolve
   references you need to understand the selected code; do not catalog framework built-ins").
   No hard jail (there is none today anyway; only secret-mask hides secret files).
7. Drop dead `excludedPaths`/`selectedPaths` columns + repos-page top-level toggles. Add a fresh
   clearly-named column for the deny list. Repos-page becomes a deep+hidden tree, gated on the
   deny list existing (post-onboarding), with "(N files, M ignored)" badge.
8. One unified deep tree-walker that INCLUDES hidden folders (collapsed, toggleable; do NOT recurse
   into node_modules/vendor) and merges the four divergent ignore-lists into one baseline. Shared by
   the picker, 09_7, env-detect fileTree, task-end. 09_7 becomes a read-only RAG confirmation.
9. Tests are NOT fenced (agent should mine/retrieve test patterns).
10. LSP: extend composeSandboxImage with a selection-driven LSP layer, fold lspServers+versions into
    the hash, MOVE LSP install out of env-replicate/02 into that layer. Fix php→phpactor→intelephense.
    Claude-family only for now; DEFER universal LSP-via-MCP bridge (large). No LSP via MCP protocol.
11. Mirror: `.haive-data/` committed multi-file (environment.json / exclusions.json / tooling.json),
    each schemaVersion'd. EXCLUDE machine-specific/infra (ollama URL, RAG connection string). Write at
    12-post-onboarding; import at handleClone/handleCopyLocal/handleExtract after persistDetection.
12. Retrieval: rewrite prompt guidance from fallback-chain to discover(RAG/KB)→ground(LSP+grep run
    together). ~8 prompt builders + the rag_search tool description. NO new orchestration engine.

## Code anchors (from research — execute without re-searching)
Scope injection (agentic prompt builders + det predicates):
- 06_5-agent-discovery.ts: buildAgentDiscoveryPrompt:549 (fileTree inject); requiredCapabilities:[] @1108 (cheap; KEEP full-repo).
- 08-knowledge-acquisition.ts: buildKnowledgePrompt:174; existing "This repo's OWN custom code lives under:" line ~215 (sourced from customCodePaths.include = broken FRAMEWORK_PATTERNS; REPOINT to deny-list complement); IGNORE_DIRS:100; single llm @1287.
- 09-qa.ts buildPrompt:137 ; 09_2-qa-resolve.ts buildPrompt:173.
- 09_5-skill-generation.ts buildSkillPrompt:693; collectShortFileTree:210; IGNORE_DIRS:109; agentMining:1035; "deeply explore this repository" @824.
- 01_5-ripgrep-config.ts scanExtensions predicate ~:124.
Trees / exclusions:
- framework-detect.ts buildFileTree drops ALL dotfolders except .ddev @91; EXCLUDED_DIRS:51; detectFramework startsWith @120; computePathSelection:172.
- 09_7-rag-source-selection.ts buildTree:60; IGNORE_DIRS:34; FRAMEWORK_PATTERNS use:218-235; collectDefaults:170; directory-tree field:309.
- 10-rag-populate.ts collectCodeFiles selectedDirs:510-538; CODE_IGNORE_DIRS.
- FRAMEWORK_PATTERNS.drupal @ constants/index.ts:592 (top-level excludePaths, no web/ prefix).
- repos schema excludedPaths/selectedPaths @ database/src/schema/repos.ts:49-50 (drop; add new col).
- web repos/page.tsx topLevelPaths:166, saveExclusions:86, excludedCount:168; api repos.ts PATCH /:id/exclusions:573-619; GET /:id/onboarding-status markers:621.
Task-end RAG / mirror:
- 11c-rag-reindex.ts resolveWorkspace/worktree:40, runRagIndexSync call:144; _rag-index.ts collectCodeFiles NO filter:84, runRagIndexSync:188, SOURCE_PREFIXES:38, orphan delete:425.
- 02-pre-rag-sync.ts (also apply deny list). 11-phase-8-learning.ts (task-history; no deny).
- 12-post-onboarding.ts BASE_STAGE_PATHS:41, `.haive/install.json`:50, `git add --`:352; _install-manifest.ts.
- clone.ts handleClone:231, persistDetection:76 (import hook after this); handleCopyLocal:135, handleExtract:213.
LSP:
- images.ts resolveSandboxImageTag:65 → ensureComposedImage; composeSandboxImage @ sandbox/image-composer.ts:42, resolveBase:81, sandboxDockerfileExtra append:60, hash:67, tag `haive-sandbox:<hash>`:72 (ComposeInput has NO lsp field — ADD it + into hash).
- env-replicate/02-generate-dockerfile.ts LSP install:354 (MOVE OUT to compose layer).
- claude-code.ts CLAUDE_LSP_PLUGINS php→phpactor:88-95 (FIX to intelephense; keep php-extended=drupal config).
- 01b-install-plugins.ts (workflow index 1.2) installs plugins; reads lspLanguages from 04-tooling-infrastructure.
- composed-image-cache.ts (VERIFY reaper behavior) ; mcp-config.ts buildDefaultMcpServers:75, buildMcpConfigForCli:165.
Retrieval:
- rag-mcp-server.ts rag_search tool (single tool; desc says "use FIRST … fall through to KB/LSP/GREP").
- Guidance to rewrite: 03-phase-0a-discovery.ts:145; 07-phase-2-implement.ts:311; 04-phase-0b-pre-planning.ts:285; 05-phase-0b5-spec-quality.ts:334; 07b-phase-4-validate.ts:267; 08c2-code-audit.ts:48; 08b-test-management.ts:268; 11-phase-8-learning.ts:714.
- resolvers.ts workflow MCP set:326 (add lsp when available).

## Slices & tasks
SLICE 1 — Exclusions core (large; sub-tasks):
  1a. [DONE] Unified deep+hidden tree-walker: worker/src/repo/scope-tree.ts buildScopeTree() + NO_RECURSE_DIRS; shows hidden folders, collapses huge dirs; returns TreeNode[]; 4 unit tests pass (scope-tree.test.ts). Existing 4 walkers NOT yet replaced (later sub-slices migrate them).
  1b. [DONE] New col repositories.scopeExcludeGlobs (jsonb string[], nullable, DENYLIST) @ database/src/schema/repos.ts + migration 0081_repo_scope_exclude_globs.sql (additive/idempotent). drizzle-pushed --force (also swept pre-existing dev-DB drift — harmless reconcile to authoritative TS schema) + db dist clean-rebuilt (rm tsbuildinfo; incremental missed the col). Dead excludedPaths/selectedPaths NOT dropped yet (separate later migration).
  1c. [DONE] New scope-picker step 06_7-scope-selection.ts (index 6.5, requiresCli:false — NOT LLM; deterministic seed instead of the planned structure-detect). detect: framework(01)+extensions(01_5)+buildScopeTree → directory-tree field; seed deny list via _scope-seed.ts computeSeedExcludeGlobs (ecosystem-general: NO_RECURSE ∪ FRAMEWORK_PATTERNS[fw].excludePaths ∪ .gitignore dirs ∪ composer installer-paths, ∩ real tree). apply: collectDenyFrontier → persist to repositories.scopeExcludeGlobs. Wired in index.ts between agentDiscovery+generateFiles. Tests: scope-seed 8/8, scope-tree 4/4; worker typecheck clean; boots clean (CLI-dispatch assertion intact). LLM structure-detect for unknown frameworks = DEFERRED (deterministic seed is fast path). Gotcha hit: literal `*/` inside a JSDoc comment (`/web/sites/*/files`) closed the block early → cascade parse errors; avoid glob text with `*/` in comments.
  1d. [DONE] Inject scope into prompt builders. New shared helper _scope.ts: loadScopeExcludeGlobs(db,taskId) (tasks⨝repositories join; try/catch→[] for mock dbs + skipped/pre-feature repos), isDeniedPath(rel,exclude) (ANCHORED prefix, not substring — `web/coreish` NOT denied by `web/core`), scopeInstructionLines(exclude) (soft-scope prompt section, []→nothing). Wired into 08-knowledge-acquisition (tree filter + soft-scope section + softened "explore" line + __scopeExclude transient stripped at apply), 09-qa (same, persists transient — no strip site, harmless), 09_5-skill-generation (collectShortFileTree gained optional exclude param + buildSkillPrompt section + softened explore), 09_5b-skill-repair (tree scoped only — repair targets specific skills). 06_5 EXEMPT (full-repo agents). 09_2 EXEMPT (detect reads only prior kbFiles, NO repo scan — plan over-listed it). All scoping is SOFT: file tree filtered for orientation, agent keeps Read/Grep/Glob to reach any file on demand. Tests: _scope.test.ts 7/7 (incl prefix-collision), full worker tsc 0 errors. NULL deny list → [] → identical to pre-feature behavior.
  1e. [DONE] Deterministic RAG. (a) 01_5 scanExtensions predicate now skips NO_RECURSE_DIRS segments — extension set describes custom code, not build-output junk (NOTE walk() already skips node_modules/.git/vendor recursion, so 01_5 never crawled those; the real cost is the LLM agent, not detect-side traversal which is seconds). (b) 10-rag-populate: loadScopeExcludeGlobs unioned into collectCodeFiles excludePaths (alongside legacy 01-env customCodePaths.exclude); deny list = single source of truth; selectedDirs allow-list now inert (09_7 emits []) → dirFilter null. (c) 09_7 REWRITTEN picker→read-only `note` confirmation: uses buildScopeTree (1a walker, retired its bespoke buildTree/collectDefaults/countRootFiles) + deny list; shows ~N in-scope files + excluded dirs + indexed extensions; still resolves extensionSet from 01_5 for 10; apply emits {selectedDirs:[], extensionSet}. Only consumer of selectedDirs was 10 (verified) → safe. tsc 0 errors, worker reloaded clean (ready, CLI-dispatch assertion intact). NULL deny list → indexes everything minus legacy exclude = pre-feature behavior.
  1f. [DONE] Task-end RAG applies the deny list. Single injection in the shared _rag-index.ts (both 02-pre-rag-sync run-start + 11c-rag-reindex post-commit funnel through it): collectCodeFiles gained optional exclude param (isDeniedPath, after CODE_IGNORE_DIRS, KB files UNfiltered — .claude/ always in scope); runRagIndexSync loads loadScopeExcludeGlobs and passes it. Plus the two direct count-preview calls (02:62 main checkout, 11c:77 worktree) scoped too so detect count == indexed count. Cross-import ../onboarding/_scope.js matches established pattern (these files already import 4 ../onboarding/ modules). Worktree paths are repo-relative → deny globs match. BONUS: stale-cleanup (line ~432) purges newly-excluded dirs from RAG when scope tightens (correct — RAG shrinks to match). tsc 0 errors, worker reloaded clean. Empty deny list → old behavior.
      Slice 1 core complete (1a-1f). 1g (web repos-page rework) is the only remainder.
  1g. [IN PROGRESS] repos-page rework. USER CHOSE full deep+hidden tree editor (not glob-list) + drop dead columns now. 5-package feature; execute A→B→C→D, typecheck each.
      Grounding: web repos page /app/(app)/repos/page.tsx = top-level checkbox UI on repo.excludedPaths (dead col); PATCH /:id/exclusions (api repos.ts:573) reads repo.fileTree(flat string[])→topLevel, writes excludedPaths+selectedPaths. fileTree is FLAT + NON-hidden (framework-detect buildFileTree drops dotfolders) → can't drive a deep+hidden tree. buildScopeTree (deep+hidden, live) is worker-only. API reads repos via storagePath??localPath (repos.ts:669/699, files/raw precedent). scope-tree.ts is PURE (node:fs + TreeNode type) → relocatable. shared exports = explicit subpaths (add ./scope-tree → dist/repo/scope-tree). Dead cols excludedPaths/selectedPaths written by clone.ts:88-89 from framework-detect computePathSelection:172 (feeds ONLY those cols) + PATCH; read ONLY by web UI + PATCH (NO scan consumer). KEEP fileTree col (other consumers). api test repo-exclusions-schema.test.ts covers the validator.
      1g-A [DONE] Walker relocated → shared/src/repo/scope-tree.ts(+test 4/4); "./scope-tree" export subpath added; 4 worker importers repointed to @haive/shared/scope-tree; shared dist clean-rebuilt; worker runtime resolves (transient ERR_MODULE_NOT_FOUND during reload race self-recovered once shared dist landed).
      1g-B [DONE] API GET /repos/:id/scope-tree (root=storagePath??localPath, live buildScopeTree, returns {tree, scopeExcludeGlobs}); PATCH /:id/exclusions repointed → normalizes+dedupes+writes scopeExcludeGlobs, NESTED globs allowed, no tree-existence validation (mirrors 06_7), strips fileTree from response; shared schema field excludedPaths→scopeExcludeGlobs; api test rewritten 7/7. tsc 0.
      1g-C [DONE] Web: api-client Repo −excludedPaths/−selectedPaths +scopeExcludeGlobs; repos page reworked — gate Exclusions on scopeExcludeGlobs!=null, fetch /scope-tree on expand, reused DirectoryTreeSelect, deny↔included conversion mirrors 06_7 (includedFromDeny/denyFromIncluded), save→PATCH, header "N files in scope · M ignored" from tree; collapsed badge = deny-count (cheap, no per-poll walk). tsc 0.
      1g-D [DONE] Dropped excluded_paths/selected_paths: db schema −2 cols +comment fix (06_7 is deterministic not LLM); migration 0082_drop_dead_repo_path_columns.sql (DROP IF EXISTS, rollback documented) applied live (verified only scope_exclude_globs remains); framework-detect −computePathSelection −2 DetectionResult fields; clone.ts stop writing; api exclusions test rewritten; db dist clean-rebuilt. Fixed latent 1c miss: onboarding-registry.test.ts (added 06_7 id + index 6.5). Worker 1611/1611, shared 185/185, api 7/7, all pkgs tsc 0.
      NOT LIVE-VERIFIED: the API /scope-tree endpoint + web tree editor need one browser hit against an onboarded repo (unit+tsc green, no live HTTP yet).
SLICE 2 — Onboarding mirror + REPO-LEVEL PERSISTENCE REFACTOR (user chose option 3, IN PROGRESS).
  Grounding: the onboarding-derived data lost on clone is NOT on the repos row — it's TASK-SCOPED (looked up via "find the repo's onboarding task → read its 01/02/04 step outputs"). Central resolvers: loadRepoStackAnchors (_repo-stack.ts:99, reads onboarding-task 01-env-detect detect + 02-detection-confirmation output.values via resolveStackVersions) + resolveRagSyncPrefs (_rag-index.ts:129, reads onboarding-task 04-tooling output.tooling {ragMode,ragConnectionString,ollamaUrl,embeddingModel,embeddingDimensions}) + env-replicate 01-declare-deps prefill (reuseLastCompletedFormValues + onboarding-task 04 read :28/:115). Other lookups: 01b-install-plugins:131, onboarding-upgrade/01-upgrade-plan:170. 02-detection-confirmation.apply currently returns {confirmed,values} ONLY (no repo write). 04-tooling.apply writes repositories.rtkEnabled + returns {tooling}. persistDetection (clone.ts:76) sets framework/languages/fileTree/size only. `.haive/install.json` commits via plain git add (so `.haive-data/` needs NO gitignore change — onboarding writes no .gitignore, only reads it).
  Design: 2 jsonb cols on repositories storing the RAW structures consumers already parse (minimal parsing change) — onboarding_environment {schemaVersion, envDetectData (01 detect .data), confirmedValues (02 values)} + onboarding_tooling {schemaVersion, tooling (04 output.tooling, incl infra for LOCAL use)}. Consumers read col first, FALLBACK to task-lookup (old repos keep working, no backfill). Mirror strips infra (ollamaUrl/ragConnectionString); import leaves infra null (per-machine).
  2A [DONE] Schema +onboarding_environment +onboarding_tooling jsonb (repos.ts, loose $type<Record> to avoid db->shared cycle) + migration 0083_repo_onboarding_mirror.sql (ADD COLUMN IF NOT EXISTS, applied live). Shared types in types/index.ts: OnboardingEnvironmentMirror {schemaVersion,envDetectData,confirmedValues} + OnboardingToolingMirror {schemaVersion,tooling} + ONBOARDING_{ENVIRONMENT,TOOLING}_SCHEMA_VERSION=1 + ONBOARDING_TOOLING_INFRA_KEYS=[ragConnectionString,ollamaUrl]. db+shared dist clean-rebuilt.
  2B [DONE] 02-detection-confirmation.apply -> writes onboarding_environment {envDetectData = RAW 01 detect.data (what loadRepoStackAnchors reads, NOT enriched), confirmedValues = args.formValues}; try/catch best-effort (apply was previously db-free). 04-tooling.apply -> extended its existing rtkEnabled .set() with onboarding_tooling {tooling} (full tooling incl infra for LOCAL). Both resolve repositoryId from task. (interface->Record cast needs `as unknown as`.)
  2C [DONE] Col-first + fallback: loadRepoStackAnchors (_repo-stack.ts, reads onboarding_environment; mirror-present skips task lookup, never returns null); resolveRagSyncPrefs (_rag-index.ts, reads onboarding_tooling for prefs + onboarding_environment.envDetectData.project.name; extracted toRagPrefs() helper; partial fallback per-field); declare-deps loadOnboardingLspKeys + loadOnboardingDetection (env-replicate/01, both col-first). Left on fallback per plan: 01b-install-plugins, onboarding-upgrade/01-upgrade-plan. DELIBERATELY NOT changed (GC needs LIVE task rows, mirror != live consumer): _rag-connection collision-check SQL, task-queue reconcileEmbedModelResidency. FOLLOW-UP [DONE — user asked to wire before commit]: cli-exec/resolvers.ts resolveRagMcpConfig (ragMode) + loadUserMcpServers (mcpSettingsJson) now read onboarding_tooling col-first before the onboarding-task fallback, so rag_search MCP + custom MCP servers wire on a clone. CORRECTED earlier "loadUserMcpServers moot" claim: the committed .claude/mcp_settings.json is NOT read back at runtime — loadUserMcpServers (DB) is the sole runtime source, so it DID need wiring; mcpSettingsJson is kept in the mirror (not an infra key).
  2D [DONE] writeHaiveDataMirror at 12-post-onboarding.apply (always-run, before commit gate) reads the onboarding_* cols -> writes .haive-data/{environment,tooling,exclusions}.json (tooling MINUS ONBOARDING_TOOLING_INFRA_KEYS). Shared: ONBOARDING_EXCLUSIONS_SCHEMA_VERSION + OnboardingExclusionsMirror + HAIVE_DATA_DIR/HAIVE_DATA_FILES consts. Added `.haive-data/` to BASE_STAGE_PATHS. KEY: `.haive-data/` is a DISTINCT dir from `.haive/` (which workflow 01-worktree-setup adds to .git/info/exclude, LOCAL-only, NOT during onboarding) so it is never excluded -> commits + travels.
  2E [DONE] importHaiveDataMirror in persistDetection (clone.ts, single chokepoint for scan/copy/extract/clone). NON-CLOBBERING: only fills cols currently NULL (live local onboarding / re-scan never overwritten), schemaVersion-gated, try/catch best-effort (never fails clone). Tooling arrives infra-stripped -> consumers use new machine's local defaults.
  2F [DONE] shared 185/185, worker 1611/1611, worker+api+web tsc 0, migration 0083 columns live. NOT LIVE-VERIFIED e2e (onboard repo A -> commit .haive-data -> clone to B -> confirm cols restored + workflow resolves stack/RAG without an onboarding task).
SLICE 3 — LSP (extend existing composer, NOT new system):
  3a [DONE + COMMITTED/PUSHED 5ca82ac main, worker 1627 tests + tsc 0]. PHP LSP fix. CORRECTED FALSE PREMISE: the Piebald-AI/claude-code-lsps marketplace has NO intelephense plugin (only phpactor [needs a composer/homebrew binary Haive never installs] + php-lsp [Rust]). Haive standardizes PHP LSP on intelephense via its OWN local plugin drupal-php-lsp (07 `.lsp.json` command:'intelephense'; env-replicate/02 installs the intelephense npm binary). The 3 adapters mapped php→'phpactor' → installed a plugin whose binary is absent → PHP LSP broken (plain php) / redundant+01b-failing (php-extended). FIX (user chose option A "local intelephense plugin"): dropped php from the 3 CLAUDE_LSP_PLUGINS maps + reuse drupal-php-lsp for ALL php via shared wantsLocalPhpLsp() at 4 gates (07 ×2, manifest render(), 01b). No contentHash churn (REFERENCE_CONTEXT has no PHP LSP). +manifest test (php & php-extended emit) +cli-adapter-stubs regression block.
  3b [TODO]. Add lspServers+versions to ComposeInput + composeSandboxImage LSP layer + hash. Move LSP server install out of env-replicate/02 (lines 354-396). RISK: LSP servers need runtimes (02 currently adds node/python/etc. to the runtimes set when LSP selected); composed layer must self-install runtime deps or rely on env-template. Reconsider env-replicate/04 LSP verify. NOTE: LSP ALREADY reaches the agent sandbox today (composed builds ON the env-template that has the servers) → 3b is architectural cleanup, NOT a functional unblock. Weigh vs simplicity before doing.
  3c [DONE + COMMITTED/PUSHED 5ca82ac main, worker 1627 tests + tsc 0, live-verified]. Composed-image eviction. NEW sandbox/composed-image-reaper.ts: reapStaleComposedImages() — lists haive-sandbox:* (docker images filter), batched inspect ({{.Id}}|{{.Created}}|RepoTags, RFC3339→ms), protects images backing a running container (docker ps {{.Image}}, by tag OR id) + age threshold (HAIVE_COMPOSED_IMAGE_MAX_AGE_DAYS, default 14d); pure selectStaleComposedImages() unit-tested (7 tests, incl NaN-created kept, exact-age boundary). Removal via defaultDockerRunner.remove (-f still refuses running-container images). Wired at worker boot after reapOrphanEnvTemplates (boot-only like siblings; cli-exec/terminal containers already reaped just before → nothing composed mid-use). exported COMPOSED_IMAGE_REPO from image-composer. Live: 9 leaked images found on the box, pipeline (list+inspect+ps+parse+select) proven end-to-end via no-op-runner maxAge=0 run (selected all 9); real 14d boot run kept all (≈3d old) → reaped 0 silently. Removal safe: evicted tag a live task needs just rebuilds (cache miss).
  3d [TODO — user-driven live e2e]. Live-verify PHP LSP end-to-end on a Claude-family Drupal task: onboard/upgrade a php-extended repo, run 01b-install-plugins, confirm drupal-php-lsp installs + NO phpactor attempt + agent gets working intelephense LSP. Needs a real task + logged-in CLI (can't self-drive).
SLICE 4 — Retrieval rewrite (rides slice 3):
  4a. Rewrite the ~8 prompt builders + rag_search desc from fallback-chain to discover→ground (LSP+grep together). Add lsp to workflow MCP/tooling set where available.
  4b. Stats: KEEP rag_query_log as-is (RAG hit% effectivity + kb/code/runbook/learning source split; logged per rag_search call incl zero-hit @ api/routes/rag.ts:165; schema/rag.ts:18; RagStatsPanel @ web tasks/[id]/page.tsx:2814). Do NOT add LSP/grep counters — LSP is CLI-plugin-internal (~30% visible), grep = fragile bash parse; both would key on ephemeral stream/bash surfaces we avoid. KB is NOT a separate channel (indexed INTO rag, reached only via rag_search). Only changes: (1) reframe RagStatsPanel copy so "effective X%" isn't read as "agent used RAG X%" — note grounding (LSP/grep) is unmeasured by design; (2) optionally render the panel on implement/validate phases too (rag_query_log is already per-step time-windowed; API supports it, web restricts to 03 discovery). NOTE: combined flow decouples RAG-miss from LSP/grep usage (LSP/grep now used on hits too), so do not relabel miss-rate as fallback-usage.

Order: 1 ∥ 3 → 2 after 1 → 4 after 3.

## Open verifications (do at slice start, not blockers)
- composed-image-cache.ts + reaper: do composed images survive teardown? (slice 3c)
- ensureComposedImage: does it pass the task env-template as base? (slice 3 context)
- [RESOLVED 2D] .gitignore: onboarding writes none; `.haive/` exclusion is LOCAL (.git/info/exclude) + set by WORKFLOW 01-worktree-setup, not onboarding, and matches only `.haive/` not `.haive-data/` → `.haive-data/` commits with no gitignore change.
- [RESOLVED 2E] import reconcile: chose FILL-IF-ABSENT (only cols currently NULL), not mirror-wins — a live local onboarding / re-scan must never be clobbered by stale committed files.

## Non-goals (explicit)
- Universal LSP for gemini/codex/amp via an LSP-to-MCP bridge (large; deferred). Claude-family only.
- LSP over MCP protocol (rejected; LSP is installed into the CLI image, not bridged).
- Deterministic retrieval orchestration tool / combined_search MCP (rejected; fights agentic arch).
- RAG-only include list for built-in modules (deferred escape hatch; one deny list for v1).
- Two separate deny lists (mining vs RAG) — one list; built-ins reached live via LSP/grep.

## Constraints reminders
- Per-container node_modules isolated: typecheck each package in its own container.
- New llm step / shared change: rebuild shared dist or worker assertCliDispatchListInSync crash-loops.
- DB change: edit schema + paired numbered src/migrations/0NNN.sql (idempotent) + drizzle push --force.
- Small reviewable slices; don't bundle. WSL: ≤7 concurrent subagents.

---

# Amendment — 2026-08-21: the header Status line is stale

The `Status:` line at the top ends "Next: commit slice 2 (pending user), then Slice 3 (LSP compose
layer) OR Slice 4". That is no longer where the work stands — slice 2 was committed and slice 3 is
partly shipped. Actual state:

- **SLICE 1 — complete** (1a-1g, including 1g-D dropping the dead columns). Not live-verified: the
  API `/repos/:id/scope-tree` endpoint and the web tree editor have never been hit in a browser.
- **SLICE 2 — complete and pushed** (`e0bee51`). Not live-verified e2e (onboard on host A, clone to
  host B, confirm the columns restore).
- **SLICE 3 — partly shipped** (`5ca82ac`): 3a (PHP LSP fix) and 3c (composed-image eviction) are
  DONE. **3b** (LSP compose layer) and **3d** (live PHP LSP e2e) are still TODO.
- **SLICE 4 — not started.**

Read the per-task `[DONE]`/`[TODO]` markers in the body, which are accurate; the header line is not.
