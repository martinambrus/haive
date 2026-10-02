# Project state that travels between installations

> **In progress** (2026-09-26). Track B of `found-not-fixed-sweep-3.md` (plan file
> `compiled-noodling-squid`). Phase 0 shipped, each live-verified: B0.1 (#326), B0.2 (#327) and
> B0.3 (#328).

## Context

Two installs (A, B) share one git remote, each with its own Postgres. Today B can clone but never
upgrade (no rows, no render context: 409 and a 01 throw), a pulled upgrade turns every file A
changed into a conflict on B, the mirror is imported once into NULL columns and never again,
`.haive/install.json` is never read, plan edits can be silently reverted when commits arrive by
any route but plan Pull, and per-user content (rules block, CLI folders) makes installs fight.

The user expects a committed sync file from which a second Haive installation can restore
onboarding, because two people working on one project from their own installs will be common, and
moving a project between installs "must work and be synced correctly and fully".

## Decisions (2026-09-26)

- **Onboarded elsewhere:** not "explain and refuse" — the repository must carry its onboarding so
  another install restores it and stays in sync (Track B).
- **Sync commit policy:** the project-state record rides every commit Haive already makes; at the
  moments Haive already pushes, pending sync files go in a separate `chore(haive)` commit; the
  onboarding and upgrade commit defaults to ON when the repo has an origin (push stays opt-in);
  a "Haive data" panel shows written/committed/pushed with Save and Save & push.
- **Same-key conflicts between installs: ask each time.** A key both installs changed since
  their common base is held as a pending conflict with both values; nothing is chosen for the
  person. Only operations that would WRITE the contested state wait (see B-conflicts); everything
  else keeps running on the local value, and the conflict is shown until answered.
- **AGENTS.md rules block:** repository-level (Haive's default rules plus an optional repository
  override on the tooling page, synced like other settings); personal rules reach Haive's own
  agents through dispatch injection only.
- **CLI folders:** the repository keeps the UNION of its installs' CLIs; a CLI is dropped only by
  an explicit action; no upgrade offers to delete a teammate's CLI folders.

## Design

- **The record:** `.haive-data/state/`, one file per unit so git's merge unit is ours (different
  files never conflict): `format.json` (schemaVersion), `project/environment.json`,
  `project/render.json` (projectInfo, framework, acceptedAgentIds, customAgentSpecs,
  lspLanguages), `cli/<provider>.json` (the repo-level CLI union), `settings/<name>.json` (one per
  portable setting), `artifacts/<slug>~<h32>.json` (one claim per disk path: path, template, kind,
  schemaVersion, templateHash, writtenHash, haiveVersion — never the bytes, which are in git),
  `bundles/<slug>~<h32>.json` (portable bundle descriptors). Canonical form: UTF-8, LF, 2-space,
  sorted keys and sets, trailing newline, no timestamps, no install ids. Portable bundle template
  ids `custom:<gitUrl#branch|zip:name>:<sourcePath>`; an unmapped claim is `foreign` (claims its
  file, never offered). `applicable_template_ids` is recomputed on import, never carried.
- **Columns:** portable — `scope_exclude_globs`, `onboarding_environment`, `rtk_enabled`,
  `rtk_version`, `lsp_servers`, `lsp_server_versions`, `chrome_devtools_mcp_version`,
  `review_dimensions`, `app_auth` shape (not `enabled`), the new `render_context` and
  `agent_rules_override`, `kb_synced_commit`/`plan_synced_commit` (ancestry merge);
  `onboarding_tooling` split (lspLanguages → render; rag model/dims fill-if-absent;
  `mcpSettingsJson` consent-gated; rag connection, ollama, keepRepoMcpServers local);
  machine-local — placement/identity, runtime status, `secret_mask_*` (a committed file must never
  lower another machine's masking), `pr_workflow_enabled`, `step_guidance_enabled`,
  `rag_embed_lexical_only`, `onboarded_at`/`onboarding_reset_at`; derived — detection, file tree,
  applicable ids. Step guidance is not synced for now.
- **Import, `syncProjectStateFromCheckout(db, repoId)`** (worker `src/project-state/`), under a
  per-repo advisory lock: watermark (`synced_head`, `synced_hash` over the state files' blob ids);
  defer while an onboarding/upgrade task is live; read through fs-safe and refuse the whole record
  on conflict markers, schema errors, a newer `format.json`, an unsafe path or a name/path
  mismatch; three-way merge with base = the record at `synced_head` from git (fallback
  `base_snapshot`), local = the DB rendered by the writer's loader, incoming = disk; per key /
  set member / claim: one side changed → that side; both identically → either; **both differently
  → a pending conflict (user decision)**, except a claim whose `writtenHash` equals the bytes on
  disk (the ledger follows the bytes); ledger adoption in one transaction (import rows superseding
  local ones, a remote removal retires an unchanged row, local-only additions kept; retiring every
  base claim stamps the local reset epoch); machine-local columns never written.
- **B-conflicts:** a `project_state_conflicts` table (repo, key, base, local, incoming, detected,
  resolution). Unresolved: the DB keeps the local value; the writer leaves that key's file as
  incoming; upgrades refuse while a claim or render-context key is contested; plan flushes skip a
  contested node; the Haive data panel and a banner on the repo's pages ask "keep mine / take
  theirs" per key; answering applies, rewrites the file and clears the row. Workflow tasks run on.
- **Write, `writeProjectStateRecord`:** sync first (except inside the live onboarding's own
  step 12), render, write only changed files (`writeFileNoFollow`), delete only files it owns that
  the render no longer produces, never touch unknown files. Outbox `markProjectStateDirty(tx)`
  in every mutating transaction (api and worker), flushed by a 10 s sweep on the plan-mirror
  queue and synchronously at 12/02/04.
- **Checkout moves:** `setAsideHaiveProjections` (projection files dirty vs HEAD must equal the
  last-written hash or the move is refused naming the file; the dirty flag is set first; restore
  with `git checkout HEAD --`) before, and the sync after, at `persistDetection`, 00a, the merge
  resolver (same-branch), plan Pull/Save, 13, refresh, and task end; a 60 s sweep catches moves
  Haive did not make (skips MERGE_HEAD/REBASE_HEAD).
- **Plan:** a flush never overwrites a `plan.json` it has not imported and never writes mid-merge;
  a three-way reconcile (base = `plan.json` at `synced_head`) applies remote deletions of untouched
  nodes when a base exists (additive without one); same-field conflicts go to B-conflicts; a
  stage-level resolver (`:1:`/`:2:`/`:3:`) replaces the wholesale `--theirs` in every merge Haive
  drives.
- **Repo-level content:** `render_context.cliTargets` is a union (07 adds the onboarding user's
  CLIs, upgrade offers adding the upgrader's, removal explicit); the cli-rules region renders from
  `agent_rules_override ?? DEFAULT_AGENT_RULES`.
- **Legacy:** `.haive/install.json` retired (stop writing and staging; the first commit carrying
  the record also `git rm --cached` it); `environment/tooling/exclusions.json` no longer written,
  still read as the fallback when no record exists. **Version skew:** a newer `format.json`
  refuses import and write; claims from a newer Haive release block upgrades on the older install
  with a banner. **Kill switch:** `CONFIG_KEYS.PROJECT_STATE_SYNC_ENABLED` (default on).
- **Migrations are reversible by design:** imported claims are `source='backfill'` with
  `source_step_id='project-state-import'` — NOT a new `artifact_source` enum value, which Postgres
  cannot drop; `onboarding_artifacts.task_id` becomes nullable with a CHECK tied to that marker
  (undo: delete the marker rows, `SET NOT NULL`); every backfill reader is audited for the marker
  (`unclaimBackfilledEdits`, 04, `loadCliRulesRenderHashes`, upgrade-status). New tables/columns
  are additive (`project_state_sync`, `project_state_conflicts`, `repositories.render_context`,
  `agent_rules_override`, `plan_mirror_state.synced_*`), declared last.

## PRs (dependencies in brackets)

Phase 0 (live exposure, independent):
- **B0.1 fix(worker,api): imported MCP server definitions are inert until accepted on this
  install.** Import moves `mcpSettingsJson` to `importedMcpSettingsJson`; `loadUserMcpServers`
  ignores it; tooling page banner with 04's opt-in wording; `PATCH tooling
  {acceptRepoMcpServers}`. Control: B's `loadUserMcpServers` returns the repo's server today, `{}`
  after until accepted. Adds the repo doc. **Shipped** #326 (`ce255ca5`), live-verified on the dev
  stack: a folder import holding a foreign server and a forged acceptance was held, the tooling page
  banner fit at 375/768/1280, accept and discard went through the real route, a mixed request got
  400, and a worker restart left the accepted list alone. **As built:** the PATCH field is
  `repoMcpServersAction: 'accept' | 'discard'`, a compare-and-set on the column; a server counts as
  Haive's only when its definition equals Haive's own under that name; the import strips the three
  consent keys from the committed file; and a boot repair (`holdImportedMcpServerLists`) holds rows
  imported earlier, skipping a record this install's own 04 wrote and a list accepted here. The
  acceptance record is an HMAC keyed with the install's encryption key (Codex round 1: a plain hash
  is forgeable by a mirror an older release imported verbatim), and the PATCH decides only after
  every other field has validated. Control: `smoke:mcp-import-consent` fails 3 of 9 with main's
  `clone.ts`, passes 9 of 9 with the fix.
- **B0.2 fix(worker,api,web): refresh-tree fetches and fast-forwards.** New REFRESH job: fetch,
  refuse on tasks in flight, dirty tracked files, unpushed commits or divergence (naming the
  count), `merge --ff-only` with the `--deepen=50` fallback, then `persistDetection`; with no
  usable checkout, the old tree is moved aside, never `rm -rf`; no-origin sources answer "nothing
  to refresh from". Control: a checkout with one unpushed commit is re-cloned today (commit lost),
  refused after. **As built:** a writable folder import fetches from the host folder itself, not
  from an origin, and fast-forwards (user's call, 2026-09-26: on this install 8 of 14 repos are such
  imports, with no remote and ~60 tracked files Haive changed). Dirty tracked files are not refused
  up front: `merge --ff-only` refuses only when an incoming commit touches one, which is the case
  that can lose work. The claim kind is `refresh`; the tasks that block it are
  `CHECKOUT_HOLDING_TASK_STATUSES`, now shared with plan Pull; an unusable tree goes to a
  `<repoId>.aside-<time>` sibling; the api answers 409 for no remote and no folder, and for a task
  holding the checkout. No web change was needed: the repos page's Retry is the one caller, and its
  red status line carries the refusal. Controls: on main the unpushed commit is gone after a
  refresh; `smoke:repo-refresh` passes 14 of 14; `repo-refresh-tree.test.ts` fails 4 of 4 against
  main's route. **Shipped** #327 (`69369fee`), live-verified on the dev stack: a writable folder
  import fast-forwarded to a new folder commit; with a commit of its own beside a new folder commit
  it refused ("Not refreshed: this checkout has 1 commit that the folder it was imported from does
  not, and the folder it was imported from has 1 commit it does not. Nothing was changed.") and kept
  its commit as HEAD; a task holding the checkout and a blank repository each got 409. Codex round 1
  (the task check is read once, and nothing that starts a task reads the claim) was answered in
  AGENTS.md rather than with a gate: it is the window writer 1 leaves open for the reset, and it
  loses nothing here.
- **B0.3 fix(worker): the mirror import reads through fs-safe and applies `rtk_enabled`.**
  Control: a symlinked `tooling.json` is imported today, ignored after; `rtkEnabled:false` in the
  mirror leaves the column true today. `fs-ratchet.json` `clone.ts` 10 → 9. **Shipped** #328
  (`a52ece09`), live-verified on the dev stack: a folder import whose mirror said RTK off came in
  with `rtk_enabled` false and its scope list, and one whose mirror files were links out of the
  repository imported nothing and kept RTK on. **As built:** the three files are read through
  `readFileNoFollow` from the repository anchor with a 1 MiB cap, and `rtkEnabled` rides the tooling
  import, which runs only while `onboarding_tooling` is NULL. A row imported before this keeps its
  column; B1.5 asks about it (Codex round 1). Control: `smoke:mirror-import` fails 3 of 5 with
  main's `clone.ts` and passes 5 of 5.

Phase 1 (the record):
- **B1.1 test(worker): two-install round-trip smoke with a strict known-gap list.**
  `packages/worker/test/two-install-smoke.ts` (+ `test/support/two-install.ts`): two databases
  (`haive`, `haive_h5` on 55432; CI creates `haive_b`), one bare `file://` remote, A's onboarding
  driven through the real 07/12 steps from seeded rows, B via `handleClone`. Each later PR removes
  its gaps (a gap that passes fails the run), which is its control. **As built:** one file, and B's
  database is the smoke's own (`two_install_smoke_<random>`, created on `DATABASE_URL`'s server, migrated
  by the real runner, and dropped at the end only by the run that created it, a failed migration
  included), so CI needs no extra step; neither install calls
  `initDatabase`, so a singleton `getDb()` on the path would throw rather than cross installs. The
  smoke pushes A's commit itself, since 13 runs inside the step runner's merge phase. A onboards a
  small Drupal fixture through every deterministic step 07 reads from (01, 02, 04, 06_5, then 07 and
  12, with no LLM pass), so the environment, tooling and RTK switch are written by the steps that
  own them, and the first check is A's render context: framework, LSP languages, accepted agents,
  and the agent and LSP plugin files they produce. Seeding the repository columns alone left 07
  rendering an empty context (Codex round 1; MEASURED without those steps: framework null, no LSP,
  no agents, 7 files), against which every later check would pass empty. Passing today: the round
  trip, the mirror (environment, tooling without its machine-local keys, exclusions, the RTK switch)
  and the plan. Known gaps: B holds A's claims (B1.6), B's upgrade plan reads every claimed path
  `unchanged` (B1.6), and a second 12 run leaves A's checkout clean (B1.7; today
  `.haive/install.json` differs). B1.4c closed the gap of B's upgrade plan resolving a render
  context naming A's framework, agents and LSP languages.
  A listed gap no check names fails the run too. The scenarios that need machinery not built yet (a
  sweep, the record, conflicts) arrive with the PRs that build it, each with its own check.
  MEASURED: 17 checks, 4 gaps, 35 paths claimed on A; a passing check listed as a gap and a listed
  gap no check runs each fail the run.
- **B1.2 fix(worker): an upgrade adopts a file that already holds the current render.** New
  `adopt` bucket in `classifyEntry` (live row, disk equals the current render); 02 supersedes the
  row with a render-claiming backfill row, outside `writtenPaths`/`createdPaths`/`retiredRowIds`.
  Control: `upgrade-plan-classify.test.ts` (today `conflict`). **As built:** `adopt` comes after
  `clean_update`, so a file still holding its row's baseline is rewritten as before. 02 adopts with
  no form choice, reads the bytes again at apply and leaves a file changed since for the next
  upgrade, and inserts only once its supersede retired the row, so a retry adds nothing. The form
  names adopted paths in a note only when it asks something else. Controls, each failing on main:
  the classify case, `classifyApplyAction`, and `upgrade-apply-adopt.test.ts` (an agent file and the
  rules region adopted, a retry recording nothing, a file edited after the plan left alone).
- **B1.3 feat(shared): project-state record codec** (pure `packages/shared/src/project-state/`:
  types, canonical render, zod parse, three-way merge returning conflicts, claim naming, id
  mapping, state hash). Control: determinism, round-trip, the merge table, and a `git merge-file`
  property test (edits to different units merge cleanly; the same edits on one pretty JSON file
  conflict). **As built:** `@haive/shared/project-state`. The schemas are strict, so a new field is
  a format bump, while a file no kind claims is left out and listed rather than refused, so a newer
  release's additions survive an older parser. The parser refuses the whole record, with a reason of
  its own for a newer format, on conflict markers anywhere, a missing or newer `format.json`, a file
  that is not JSON or fails its schema, a claim outside the repository, a file under another unit's
  name, and a setting holding null or a set setting that is not a list of strings. The renderer
  normalizes the record and then validates it: each section against its schema, every CLI member as
  a record name, and every value for what JSON cannot carry (a non-finite number, a bigint, a
  function, an undefined array element, a non-plain object, a cycle, a `__proto__` key, a key JSON
  does not write: a symbol, a non-enumerable key, an array's named property; an accessor, which JSON
  calls when it writes, so what it writes need not be what was checked; a proxy, which can answer
  any of these checks falsely) and every value nested deeper than 64 levels, which keeps each later
  walk of it inside the stack, so a record either renders to files that read back as itself or
  throws `ProjectStateError`. Nothing reads inside a value before that walk (it runs ahead of zod
  and of sorting a set), and normalizing reads the record's own containers once into the fresh ones
  that are checked and written, so what is checked is what is written; a container that cannot be
  read is a `ProjectStateError` too. "As itself" is under `sameValue`, the equality the merge
  decides with, so what JSON writes differently but no reader can tell apart passes: an undefined
  object property is left out, and a negative zero is written as 0 (`-0 === 0`). The parser runs the
  same check on every file before its schema, since zod would drop a `__proto__` key and read the
  record back without it. Every settings map has no prototype, so an absent setting named like an
  `Object.prototype` member reads as absent, and the parser checks a setting's name before storing
  it. The renderer writes each file with its schema's keys alone, and sorts every set
  (`acceptedAgentIds`, `lspLanguages`, the CLI set, declared set settings), which the renderers can
  take since all of them read those as sets. The merge goes key by key in a project file both sides
  hold and file by file otherwise; a set (a set setting, the CLI set, `lspLanguages`) moves member
  by member and never conflicts (joined when there is no base); a side that unset a set holds no
  member of it, and a set that empties that way stays unset; `acceptedAgentIds` stays one value,
  since an empty list there means every applicable agent and two narrowings would merge wider than
  either chose; a claim both sides changed follows the bytes through `diskHash`, an absent file
  standing for a removal; a conflict keeps the local value and names `<file>#<key>` or the file.
  Portable custom ids encode both parts (`custom:<source>:<path>`, each URI-encoded), since a git
  URL holds colons, and a git source encodes its URL and branch apart, since `#` is valid in both.
  An http(s) remote is named as the URL standard serializes it (host, port and path resolved, dot
  segments included) without userinfo, a query or a fragment, since each can carry a token. An ssh
  URL and an scp address keep only the user, which is a login, name the host as the standard does
  and drop a default port, while the path stays as typed, since the remote's own filesystem resolves
  it. The source is compared exactly after that: other spellings of one remote (a trailing slash, a
  `.git` suffix, an scp address against an ssh URL) stay two sources, and their claims read foreign
  until the bundle is added under one spelling: the safe direction, since a foreign claim keeps its
  file and offers nothing. A token pasted into a path segment reads like a name and stays, which is
  why a bundle's credential is stored apart from its URL. One maps back only when exactly one local
  bundle holds its source: two (two ZIP bundles of one name, or one git bundle added twice) leave it
  foreign rather than guessing. Two keys of one project file can still conflict under a merge a
  person drives, which the parser then refuses; the merges Haive drives resolve them per key (B2.3).
  `gitBlobId` takes the repository's object format (sha1 or sha256), since the two never agree on
  one file and the sync compares against ids read from the repository. MEASURED: 119 tests, every
  mutation tried caught (Codex's twelve rounds added 49 controls, 41 of them failing before), and
  `git merge-file` over all 28 pairs of eight single-file edits merges cleanly to the render of the
  record merge, while two adjacent settings edited in one pretty JSON file conflict.
- **B1.4 feat(worker,api): sync settings and render context; 01 and the gates read them**
  [B1.3]. `project_state_sync` table, `repositories.render_context`;
  `syncProjectStateFromCheckout` replaces `importHaiveDataMirror` (legacy files as fallback);
  12/02/04 write `render_context`; 01's `resolveRenderContext` reads it first; POST /tasks and
  upgrade-status accept a repo with a render context. Control (smoke gaps): B's 01 throws today,
  plans after.

  **A commits the render context, because B cannot derive it.** MEASURED on the dev install across
  13 step-07 detect outputs: `framework` and `lspLanguages` are reproducible from the committed
  mirrors (13 of 13), but `acceptedAgentIds` and `customAgentSpecs` exist only in A's database —
  `install.json` carries neither (5 of 33 agents missing on one repo), the agent folders overcount
  (45 files against 33 accepted), and the README index is a human-facing table. A derivation that
  is wrong is wrong SILENTLY, so B1.4 commits `.haive-data/state/format.json` and
  `project/render.json` and nothing else: settings and environment stay out until B1.8, because
  `PATCH /tooling` and `PATCH /exclusions` rewrite no file, so a record carrying them goes stale on
  the first edit and the next sync reverts it. `projectInfo` is NOT reproducible either (docroot
  differs on 7 of 7, since 07 reads 01's `enrichedData` while the mirror stores 01's detect data),
  which is the second reason the file is committed rather than rebuilt.

  **Writers: 12, 02 and 04, each stamping the sync in the same transaction.** A writer that rewrites
  a record file without moving `project_state_sync` leaves A's own next sync with no base — and with
  no base the incoming side wins, so the stale file on disk overwrites the newer DB value. Traced as
  a sequence: A onboards (12 writes R1), upgrades (02 writes R2), refreshes, and `render_context`
  goes back to R1. So each writer sets `base_snapshot` to what it wrote, and the sync merges
  against it. A watermark (the hash of the files and the commit holding them) has no reader until
  B3.1, when a checkout can move without a sync, so B3.1 adds it with that reader rather than B1.4
  writing columns nothing reads. A unit the merge leaves in conflict keeps
  its old base, so the next sync finds the same conflict again rather than settling it for the local
  side, until B1.5 asks the person. 02 must also list both files in `writtenPaths`, because 03's
  base stage list does not name it and a workflow task checks out HEAD.

  **The legacy fallback becomes PER UNIT.** The plan's "no record → legacy files" rule would make a
  partial record switch the whole legacy import off, so a repository carrying only
  `render.json` would stop importing environment, tooling and exclusions. Each unit the record does
  not cover is filled from its legacy file as today, fill-if-absent, which also keeps B0.1's MCP
  consent hold and B0.3's `rtkEnabled` in one importer. B1.7 `git rm`s each legacy file in the
  commit that first carries its unit. The importer re-adds
  `ONBOARDING_ENVIRONMENT_SCHEMA_VERSION` when it writes the column, since the record versions
  itself through `format.json` and the column's readers gate on their own version.
  The sync renders its local record before it merges (`renderProjectState`), which applies the
  codec's depth bound, its descriptor walk and its unreadable-record refusal in one call: the
  merge compares through canonical JSON, which recurses, and only the parser bounds what it
  produces. It reads each record file as bytes and refuses one that is not valid UTF-8, since a
  blob id computed from lossily decoded text matches no id git reports.

  **`render_context` carries the whole snapshot, and an RTK choice is recorded explicitly.**
  `upgrade-status` mirrors 01's choice of context for RTK (its RTK add-back and
  `rtkChoiceFollowsLive`), so once 01 reads the column first, the banner must read it through the
  same order or the two diverge: on a repository with RTK off, no rows and a git source, 01 probes
  unrecorded RTK settings files while the banner stays silent about the removal the plan offers.
  The column therefore holds the 8 `TemplateRenderContext` fields, the enabled provider names, and
  a `rtkChoiceRecorded` flag that is STORED rather than inferred — 01's 07-detect fallback writes
  `rtkEnabled: false` for a choice nobody made, and the next read takes that for a recorded one.
  One resolution order lives in `@haive/shared` and is read by 01 and by the api. 04 is a writer
  too: it restores a prior snapshot, so leaving it out makes 01 and the banner read different
  contexts after a rollback.

  **The gates gain one term, and only that term is guarded.** A shared helper in
  `api/src/lib/onboarding-state.ts` adds `render_context IS NOT NULL AND the onboarding verdict is
  onboarded` to `POST /tasks` and upgrade-status, checked only when the two existing terms fail.
  The bare column is not enough: it would admit a repository during its own onboarding, after a
  reset, and with a marker missing. The existing terms are left as they are — aligning them with
  the verdict changes what already-reset repositories see and belongs in its own fix.
  `applicable_template_ids` follows the render context the sync writes, but only where claims
  exist. A sync that changes the column of a repository holding a claim recomputes the set in the
  same transaction through 01's own functions, so the set is what the plan renders, and
  upgrade-status reports a claim outside it while 02 could still remove it. A repository with no
  claims keeps its set until 01's first plan fills it: with no claims a recomputed set makes every
  applicable template read as changed, and B1.6's import gives such a repository claims.

  Migration 0171, additive, the column declared last, the foreign key named
  `project_state_sync_repository_id_repositories_id_fk` (an inline `REFERENCES` takes Postgres'
  `_fkey` name and turns `schema-parity` red). Undo: drop the table and the column.

  **As built, B1.4a (the writers; nothing reads the column yet).** `renderContextColumnSchema` and
  `portableRender` live in `@haive/shared/project-state`; `renderTargetsFor`
  (`step-engine/_render-targets.ts`) is 07's derivation moved unchanged, pinned through 07's
  `detect`. `writeProjectStateRecord` (worker `project-state/write.ts`) parses the column value
  first, so a context the schema refuses writes nothing at all: only a snapshot from before
  2026-04-27 (when 12 began storing one) or a rollback's `{}` can be one, and it gets a warning and
  no record, since the record must not invent a context. It then writes the files and, in one
  transaction, takes an advisory lock on a per-repository key distinct from the plan mirror's,
  sets the column and upserts the sync row. Files before the lock is the design above: two
  overlapping writers (an onboarding beside an upgrade) can leave one's files with the other's
  column, which the next sync converges. 12 derives its context from 07's output before anything
  else and writes whenever it exists, whatever recording the artifacts did. 02 adds both files to
  `writtenPaths` even when the database half fails (the writer's rejection names the files it
  wrote), since they are what a later sync takes as the intended context and 03 commits only what
  02 lists. 04 writes the snapshot it restored or, for a rollback of an upgrade that only created
  files (no snapshot among its targets), the one the rows still live after it carry. The RTK flag
  is never read off the value, since 01's pre-RTK fallback stores a synthesized `false`: 02 takes
  its plan's `rtkFollowsLive`, 04 the rolled-back upgrade's plan's (and a boolean in what it
  restores), and 12 whether 07's output recorded RTK at all. The onboarding reset takes it all back: the two files by name, their directories only once
  empty, and the column and the sync row in the transaction that clears `onboarded_at`. The
  repositories LIST query does not fetch the column: MEASURED on 13 step-07 outputs, a context is
  11-42 KB against ~3.3 KB for the rest of a list row, and the list is polled every 5 s.

  **As built, B1.4b (the sync; still nothing reads the column).** `syncProjectStateFromCheckout`
  (worker `project-state/sync.ts`) runs from `persistDetection` after the legacy mirror import and
  before the plan import, non-fatal, so every clone, copy, extract, scan and refresh reads the
  checkout's record. It merges the render unit alone: environment, tooling and exclusions still
  come from the legacy importer, and a unit this release does not map is neither applied nor kept
  in the base. The walk reads the whole state tree, since the codec reads a record whole or not at
  all, and refuses past 4,096 entries or 16 MiB, stopping there; each file is capped at 1 MiB, and
  a link, a non-regular file or bytes that are not UTF-8 refuse the record. The local record, the
  column's portable fields, goes through `renderProjectState` before the merge, since `projectInfo`
  and `customAgentSpecs` hold values only the codec bounds. The base is read first and the files
  next; then one transaction takes the writer's lock (`lockProjectState`, shared with `write.ts`),
  defers to a live onboarding or upgrade (`CHECKOUT_HOLDING_TASK_STATUSES`, which leaves `created`
  out so a task stranded at creation cannot hold the sync off for good), re-reads the base and
  stands down as `superseded` when a writer recorded one since, and locks the repository row. The
  new base is the CHECKOUT's record, not the merged one: a merged base reverted a local-only change
  on the next sync, since the checkout still held the record the change departed from, and dropped
  a set member added beside a teammate's. A conflicted key keeps its old base, so the next sync
  meets the same conflict until B1.5 asks, and `last_error` names the keys. A refusal writes
  `last_error` only on an existing row: a new row needs a base, and any base record turns the next
  first import into a conflict. A column the sync creates records `rtkChoiceRecorded: true`, since
  B follows its live RTK switch, which B0.3 imported from A's tooling.

  **As built, B1.4c (01 and the banner read the column first).** One order in
  `@haive/shared/project-state` decides for both:
  - `readRenderContextColumn` reads NULL as absent, and a column the schema refuses as absent too
    (01 logs it).
  - `renderContextOrigin` takes the column; else the newest live snapshot (`pickSnapshotRow`: the
    newest that recorded an RTK choice, else the newest holding one); else the history
    (`historyOrigin`: the last completed onboarding's step 07 output, else the blank scaffold).
  - With a column, the RTK choice is its stored `rtkChoiceRecorded`, never whether it holds an
    `rtkEnabled`.

  **As built, B1.4d (the sync writes the rendered set; the banner reads a claim outside it).** Codex
  round 3 on #393 found the banner reading the set the previous apply left after a sync changed the
  render context of a repository with claims, while 01 planned from the new column. The sync now
  writes, in its transaction and after the column, exactly the set 01's apply would write
  (`_upgrade-render.ts`, moved verbatim out of 01); no writer keeps an id its context does not
  render, 04 included, and upgrade-status reports a claim outside the set while 02 could act on one
  of its paths. An obsolete Haive file gains a keep choice (untracked, file left), and a rollback
  puts back the rows an upgrade untracked. Controls: 33 failing on the base for their stated reason,
  52 mutants caught.

  A column the sync wrote holds the portable fields alone. `renderContextFromColumn` (worker
  `_render-targets.ts`) completes each per-install field it lacks from the task user's CLIs through
  `renderTargetsFor`, 07's own derivation. It keeps every field the column holds, `[]` included,
  and gives an absent `rtkEnabled` `false`. Nothing is left missing, so 01 needed no new error. The
  banner names the providers through `renderContextProviderNames`, the same rule.

  The gates' new term is `renderContextAdmitsUpgrade` (`api/src/lib/onboarding-state.ts`, where
  the onboarding markers moved from the route). It requires that the column decodes, that the
  repository is `ready` with a root, and that `resolveOnboardingVerdict` calls it onboarded. POST
  /tasks and upgrade-status try it only after their own two terms fail.

  A render unit's custom agent must carry a string `id` and `description` (a loose object), the
  two fields 01's agents index renders. So a hand-edited record is refused at the sync rather than
  throwing in 01.

  A characterization grid pinned both answers before the refactor, and holds after it with every
  no-column answer unchanged: 01 across 80 cells × 3 column states, the banner across 80 × 4.
  MEASURED: `smoke:two-install` ends `TWO_INSTALL_OK` with 30 checks and 3 gaps (B1.6 twice and
  B1.7), and B's plan matches A's context on all 8 keys with an LLM custom agent in A's fixture.

  Controls, each failing on main: B's render context equals A's on all 8 keys with an LLM custom
  agent in A's fixture (the smoke's current 3-field check passes a lossy derivation); a record
  holding only `render.json` still imports environment, tooling and exclusions; A onboards,
  upgrades and refreshes with its render context unchanged; a portable-only column is completed or
  01 throws a named error rather than a `TypeError`; on B with RTK off and no rows, 01's RTK
  removals and upgrade-status agree. `smoke:mirror-import`, `smoke:mcp-import-consent` and
  `smoke:repo-refresh` stay green unchanged.
- **B1.5 feat: pending conflicts, asked, never chosen for the person** [B1.4].
  `project_state_conflicts`, the hold rules, `GET/POST /repos/:id/project-state/conflicts`, and
  the panel/banner resolution UI (browser check at 375/768/1280). Control (smoke): two installs
  change one setting differently → a pending conflict, the local value still in effect and that
  setting's file left as incoming (today the second import silently keeps one side); a contested
  render-context key refuses an upgrade; answering applies, rewrites the file and clears the row.
  It also asks about the rows B0.3 could not repair: a repository imported before B0.3 whose
  imported tooling says `rtkEnabled: false` while `rtk_enabled` still holds its default `true`, and
  no local 04 run equals that tooling. The tooling page writes the column alone, so nothing says
  whether a person switched RTK back on since; a migration would have to choose.
- **B1.6 feat(worker,api): adopt the record's artifact ledger** [B1.5]. Nullable `task_id` + CHECK,
  backfill + marker rows, `foreign` bucket in 01/02, rollback eligibility vs `imported_at`,
  onboarding verdict counts imported claims. Control (smoke): after a fresh clone B has 0 rows, a
  409 and a throw today; after, B's rows equal A's claims and 01 is all `unchanged`; after A's
  upgrade B reads `conflict` everywhere today, `unchanged` after.
- **B1.7 feat(worker): write the record at onboarding, upgrade and rollback; retire install.json**
  [B1.6]. The writer collapses local bundles to one descriptor per portable source, since the codec
  refuses a source listed twice. Control: two identical 12 runs leave `git diff` empty (today
  install.json differs).
- **B1.8 feat(api,worker): keep the record current on every settings edit** [B1.7]
  (`markProjectStateDirty` in PATCH exclusions/tooling, the reset, bundle changes, 02-detection,
  04-tooling, 06_7, bundle resync). Control: PATCH exclusions then a sweep tick updates
  `settings/scope-exclude-globs.json` (today the mirror never changes after 12).

Phase 2 (the plan):
- **B2.1 fix(worker): a plan flush never overwrites a snapshot it has not imported, never writes
  mid-merge.** `plan_mirror_state.synced_*`. Control (plan-canvas-smoke): A's `plan.json` arrives by
  a plain fast-forward, B edits another node: A's change is lost today, both kept after.
- **B2.2 feat(shared,worker): three-way plan reconcile** [B2.1, B1.5]. Control: a local title edit
  is reverted today; an untouched node deleted remotely is kept today (deleted after); a same-field
  edit on both sides becomes a pending conflict.
- **B2.3 feat(worker): Haive-owned files resolve deterministically in every merge Haive drives**
  [B1.3, B2.2]. The stage-level resolver in `mergeOriginInto`, the merge resolver's pending phase
  and 13; the fix prompt leaves those paths alone. Control (`merge.test.ts`): ours changed node X,
  theirs node Y: theirs wins wholesale today, both kept after.

Phase 3 (checkout moves):
- **B3.1 feat(worker): every checkout move Haive makes re-syncs, projections set aside first**
  [B1.7, B2.1, B2.3]; agents' changes to `.haive-data/state/**` on task branches are reverted at
  cleanup with a warning. Control (`00a-sync-base.test.ts`): a dirty Haive-written state file plus
  an incoming commit touching it → `skipped` today; ff + import + re-render after.
- **B3.2 feat(worker,api): catch checkout moves Haive did not make** [B3.1] (60 s sweep, on-read
  triggers). Control (smoke): B's plain `git pull --ff-only` is never learned today; within a tick
  after.

Phase 4 (repository-level content):
- **B4.1 feat: the repository's CLI set is a union** [B1.4] (07, 12/03 stage paths, 01, 02 stubs,
  blank scaffold, api `rulesImportGaps`, `resolveSkillTargetDirs` callers; existing repos seed
  it from their newest snapshot). Control (smoke): A claude, B claude+codex — today B's context
  offers deleting A's folders; after, codex files are new and A's untouched.
- **B4.2 feat: the AGENTS.md rules block is repository-level** [B1.8]. `agent_rules_override` +
  `settings/agent-rules.md` + a tooling-page editor; one `buildRepoCliRulesBlock` for 07/12/01/api.
  Control: two users with different personal rules each see the other's block as drift today;
  quiet and byte-identical after.

Phase 5 (visibility and commit policy):
- **B5.1 feat(api,web): the Haive data panel** [B1.8] (`GET /repos/:id/haive-data`,
  `POST …/save {push}` via a worker SAVE job; generalise `commitPlanSnapshotFiles` to a path
  list; conflict report). Browser check at 375/768/1280.
- **B5.2 feat(worker): project state rides Haive's pushes** [B5.1]: a `chore(haive)` commit of
  dirty projections before the cleanup base push, 13 and plan Save & push; the PR path commits it
  into the feature worktree; 12/03 commit defaults on when an origin exists. Control: cleanup with
  a dirty record and push leaves origin without it today, with it after.
- **B5.3 feat(worker): review watermarks travel, and Haive's own paths leave drift ranges**
  [B1.8] (`settings/review-watermarks.json`, descendant wins via `merge-base --is-ancestor`;
  `_external-drift` drops `.haive-data/state/**` and plan files). Control: B re-reviews A's
  KB-reviewed commits today; empty range after.

Acceptance for Track B: `smoke:two-install` with an empty gap list (onboard A, push, clone B,
quiet 01; concurrent settings edits; same-key conflict asked; A's RTK-off upgrade reaching B;
plan edits on both sides; an external pull; refresh refused on an unpushed commit; version skew;
union and rules block; records byte-identical at the end), and a live two-install check: a second
install beside the dev stack (`HAIVE_INSTALL_ID=haiveb`, own ports and volumes), both on one bare
remote under `/host-fs`, zero tokens, browser at 375/768/1280, everything removed after.

## Appendix: design detail

Verified facts the survey added (2a610d56):
- `onboarding_artifacts.task_id` is NOT NULL with an FK to tasks, so imported rows need the
  nullable change; `artifact_source` is a Postgres enum (`onboarding|upgrade|rollback|backfill`,
  `0000_baseline.sql:40`) — hence the backfill-plus-marker design, not a new value.
- Custom-bundle template ids are install-local UUIDs (`custom.<bundleId>.<itemId>`,
  `template-manifest.ts` `expandCustomBundlesFor`); on B they read as obsolete, hence portable ids.
- `importHaiveDataMirror` restores `tooling.mcpSettingsJson`, which `loadUserMcpServers`
  (`sandbox/mcp-surface.ts` ~223-236) hands to B's CLI — bypassing 04's explicit opt-in (B0.1).
- refresh-tree for `blank`/`upload` sources enqueues CLONE with no `remoteUrl` (clone.ts ~667) and
  the api accepts it on `ready` rows; it `rm -rf`s `.haive/worktrees` and unpushed commits (B0.2).
- `autoResolvePlanFiles` runs only inside plan merges (merge.ts ~217); 00a, cleanup base-sync and
  13 send `plan.json` conflicts to the AI fixer. `writePlanMirror` has no MERGE_HEAD check.
- For in-place `local_path` repos the worker writes `.haive-data/` straight into the person's
  checkout, and the person pulls in their own terminal: most checkout moves are not Haive's, so
  the B3.2 sweep is essential, not optional.
- 03's stage list has KB/learnings but no mirror files; the upgrade workflow has no push step;
  cleanup's `pushBase` defaults off.
- 01-env-detect's project-name fallback is `path.basename(repoPath)` (~1439-1444), a repository
  UUID under Haive storage, which can reach `environment.json` and committed renders.
- Tests: CI's smoke job has one database (ci.yml ~100-172) — the two-install smoke needs a
  `CREATE DATABASE` + migrate step; `clone.ts` is pinned at 10 path-based fs calls
  (`packages/shared/test/fs-ratchet.json`); `HAIVE_INSTALL_ID` already supports a second install
  on one machine (docker-compose.yml header).

Claim file names: slug = the path with `/` → `__` and leading dots dropped, `h32` = the first 32
hex of sha256(path), wide enough that paths chosen to collide still get two files; the parser
refuses a name that does not match its path; flat on purpose (mirroring `.claude/...` under
`.haive-data` would plant directories tools scan).

`syncProjectStateFromCheckout(db, repoId, {reason})` — worker `src/project-state/sync.ts`, `db`
explicit (the smoke drives two databases), under
`pg_advisory_xact_lock(hashtextextended('project-state:'||id, 0))`:
1. Watermark: `synced_hash` = sha256 over sorted `relPath NUL gitBlobId`; `synced_head` = HEAD at
   the last successful sync; both match → only the plan step (7).
2. Defer while an `onboarding`/`onboarding_upgrade` task is live (return `deferred`, watermark
   untouched); completion/fail/cancel hooks and the sweep retry it.
3. Read via `readdirNoFollow`/`readTextNoFollow`; refuse whole on conflict markers, schema errors,
   a newer `format.json`, an unsafe claim path (`safeDiskRel`) or a name/path mismatch → DB
   untouched, `last_error` + report in the UI. No record → legacy files, fill-if-absent (+
   `rtkEnabled`, B0.3).
4. Three-way merge. base = the record at `synced_head` read from git objects (fallback
   `base_snapshot` after a re-clone or rewritten history, then none); local = the DB rendered by
   the writer's loader; incoming = disk. Unit = a top-level key of a settings/project file, a
   member of a declared set (globs, CLI targets), or a claim.

   | base→local | base→incoming | result |
   |---|---|---|
   | unchanged | unchanged | keep |
   | changed | unchanged | local |
   | unchanged | changed | incoming |
   | changed | changed identically | either |
   | changed | changed differently | PENDING CONFLICT (user decision); claims: the one whose `writtenHash` equals the bytes on disk wins without asking |
   | no base | — | incoming wins; overwritten local values reported (first import) |

   Base = the record at `synced_head` (not "last imported content") is what makes a teammate's
   revert of your committed change apply correctly.
5. Ledger adoption in one transaction: a claim different from the live row → supersede it, insert
   a marker row (`source='backfill'`, `source_step_id='project-state-import'`, `task_id` NULL,
   `userId` = repo owner, `formValuesSnapshot` = the derived render context, `writtenContent`
   from disk only when its normalised hash equals `writtenHash`); a path in base that incoming no
   longer lists, local row unchanged → retire (remote removal); local-only additions kept; an
   import retiring every base claim stamps `onboarding_reset_at`; settings columns,
   `render_context` and `applicable_template_ids` (01's `unionExpandedFor` over the resolved
   context, as B1.4d does) in the same transaction;
   machine-local columns never written.
6. Book-keeping: set `synced_head`, `synced_hash`, `base_snapshot`; merged ≠ incoming (local
   pending changes) → mark dirty and re-render.
7. Plan: take the separate plan lock (never nested) and run the plan reconcile.

Version skew: a newer record format refuses import and write; claims with a newer `haiveVersion`
(semver, releases only) block upgrades on the older install ("last changed by Haive vX"); dev
builds compare only to themselves and warn, never block.

`writeProjectStateRecord(db, repoId)`: sync first (skipped only inside the live onboarding's own
step 12, where that run's output wins); render the DB state; write only changed files; delete only
files in `owned_files` the render no longer produces; never touch other files (so an older writer
preserves unknown future settings and not-yet-imported files); update `owned_files`,
`synced_hash`, `written_revision`.

`setAsideHaiveProjections(db, repoId, repoPath)` — a semantic stash, the DB already holds the
state: sync first; each projection path dirty vs HEAD (`.haive-data/state/**`, `plan.json`,
`plan.md`) must equal the last-written hash or the move is refused naming the file; bump the dirty
revision FIRST (a crash re-renders); `git checkout HEAD -- <paths>` for tracked, remove untracked
own files. After the move, the sync (base = the record at the pre-move head) re-renders local
pending changes on top of the new HEAD. Call sites: `persistDetection` (replacing both
importers), 00a (before `ff()`, sync after ff/merge), `resolveMergePhase` when
`mergeDir === ctx.repoPath` (sync in `reachDone`), plan `pull()`/`save()` (before
`landPlanMerge`), 13, refresh, and `markTaskCompleted/Failed/Cancelled` for onboarding and upgrade
tasks. Sweep (B3.2): every 60 s compare `rev-parse HEAD` with `synced_head` and the state-dir hash
with `synced_hash` (mtime/size prefilter), skipping checkouts with MERGE_HEAD/REBASE_HEAD; the
tooling page, upgrade-status and plan overview also enqueue a deduplicated SYNC.

Plan (B2): flush guard in `writePlanMirrorLocked` — if the on-disk `plan.json` blob is neither
`synced_hash` nor the render about to be written, reconcile first; skip (row stays dirty) while
MERGE_HEAD/REBASE_HEAD exists. Three-way reconcile per node and field with the rule table above; a
node in base, missing from incoming and untouched locally is deleted and reported; local-only
nodes kept; edges and code links merge per key; with no base the reconcile stays additive and
never deletes. `resolveHaiveProjectionConflicts(worktree)` replaces `autoResolvePlanFiles`: reads
stages `:1:`/`:2:`/`:3:`, runs the same pure merges for state files and `plan.json`, regenerates
`plan.md`, `git add`s; runs in plan merges, in the merge resolver before any fixer (committing
directly when nothing else conflicts), and in 13; add/add and delete/modify stages tested.

refresh (B0.2): with a usable checkout and an origin — credentialed fetch; refuse on tasks in
flight, dirty tracked files (after set-aside, once B3.1 exists), unpushed commits
(`origin/<b>..HEAD > 0`) or divergence, naming the count; `merge --ff-only` with 00a's
`--deepen=50` fallback; `persistDetection`. Without a usable checkout, today's clone/copy but the
old tree is moved aside (the `extractArchive` pattern); a copy refresh is refused when the volume
copy has commits the host copy lacks; no origin → "nothing to refresh from".

Repo-level content (B4): `deriveRenderTargets(cliTargets, lspLanguages)` in shared (so the api
computes the same) drives agent/skill dirs, `supportsLsp`, the RTK fan-out and the import stubs;
the upgrade form offers "Also maintain files for: <CLI>" (default on); removal on the tooling
page makes the next upgrade offer that CLI's files as obsolete. The rules region renders from
`agent_rules_override ?? DEFAULT_AGENT_RULES`; a region rendered from a personal override becomes a
`clean_update` at the next upgrade because `loadCliRulesRenderHashes` knows it as a prior render.

Adopted defaults (the owner can override at approval): retire `.haive/install.json`; legacy
mirror files read as fallback only; settings classification as in the design summary;
remote plan deletions applied only with a base; agents may not change `.haive-data/state/**` on
task branches (reverted at cleanup); bundle descriptors portable, claims `foreign` until the
bundle exists locally; a remote reset stamps the local reset epoch; step guidance not synced.
