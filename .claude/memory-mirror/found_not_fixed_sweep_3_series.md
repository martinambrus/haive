---
name: found-not-fixed-sweep-3-series
description: "IN FLIGHT from 2026-09-26: sweep 3 plus Track B (project state between two Haive installs). Track A COMPLETE 2026-09-27; Track B PHASE B1 COMPLETE 2026-10-13 (B1.1-B1.8, last #636); Track B PHASE B2 COMPLETE 2026-10-13 (#638 #640 #652 #657 #658 #660 #665, last a5c5cd6e); B3.1a MERGED 2026-10-14 as #670 (c933cc72, 38 Codex rounds; then Codex out of allowance, ignored per user); B3.1b-1 MERGED 2026-10-14 as #718 (1cb55882; C11 CI flake traced to plan.json order -> #283). B3.1b-3 MERGED #733, #283 MERGED #735 (2026-10-15). In flight 2026-10-15: B3.1b-2 (#278) = PR #751 (worktree b31b2, Codex round 3 -> fix-7); then B3.1c (#274, decided D1-D3); B3.2 (#117) DECIDED D13-D16; #287 (.haive-data read-only, D4-D7 + D12) building. Open-work index: ledger .claude/tmp/track-b/b3/ledger.md 'OPEN WORK INDEX' and the running list's 2026-10-15 block. Ledger .claude/tmp/track-b/b3/. FNF #271 DAG merge. Ledgers .claude/tmp/track-b/b1x/, b2/. User decisions, order, where the design lives"
metadata:
  node_type: memory
  type: project
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-01T08:36:22.442Z
---

Plan: the REPO COPIES are the surviving source — `docs/plans/found-not-fixed-sweep-3.md` and
`docs/plans/two-install-project-sync.md` (Track B, with the execution appendix), both committed at
the first PR (B0.1). `/home/activit/.claude/plans/compiled-noodling-squid.md` NO LONGER HOLDS THIS
PLAN: a 2026-09-27 fix overwrote it on 2026-09-27 (as this plan had overwritten sweep 2's, whose repo copy is
`docs/plans/found-not-fixed-sweep-2.md`). Read the repo copies, not that file. Session tasks
#77-#124, one per PR plus local cleanup and memory.

**Why Track B exists:** the "onboarded elsewhere" entry became a feature. The user: two people on
one project from their own installs will be common, and moving a project between installs "must
work and be synced correctly and fully". Today a second install can clone but never upgrade;
`amber-fencing-hopper` slice 2's `.haive-data/` mirror is imported once, `.haive/install.json` is
never read.

**User decisions (2026-09-26), not to re-litigate:**

- Rollback keeps a person's later edits (restore only while the file holds what the upgrade left).
- Global KB Retry shown only while the source task is `failed`; entry and seed notes kept.
- Sync commit policy: the record rides Haive's own commits; a `chore(haive)` commit at moments
  Haive already pushes; onboarding/upgrade commit defaults ON when an origin exists; push opt-in;
  a "Haive data" panel with Save / Save & push.
- Same-key conflicts between installs: ASK each time (pending conflict; only writes of the
  contested state wait; everything else runs on the local value).
- AGENTS.md rules block is repository-level (default + optional repo override); personal rules via
  dispatch injection only.
- CLI folders: the repository keeps the UNION of installs' CLIs; removal explicit only.
- B0.2, a writable local-folder import (COPY; 8 of 14 repos here, no remote, ~60 tracked files
  Haive changed): Refresh FETCHES the folder's committed history into Haive's copy and
  fast-forwards (user, 2026-09-26). Nothing is deleted; uncommitted folder edits are not copied;
  git refuses when incoming commits touch files Haive changed. Chosen over "re-copy, guarded" and
  "re-copy, keep old copy".
- Local cleanup approved: user 923dd28a, deleted users' 10 auth volumes + 2 empty `_uploads` dirs,
  orphaned `p_99b39acba6d1` volumes, 6 `bull:task-queue:*` keys (re-check each first).

- `artifact_source` is a Postgres enum; imported claims are `backfill` rows marked
  `source_step_id='project-state-import'` with nullable `task_id` (reversible) — never a new enum
  value (Postgres cannot drop one).
- Task-level Retry must re-run the step the task stopped on (ADVANCE at the new epoch), not START:
  START replays stored loop_back verdicts and re-pays fix rounds.
- The merge fixer's scoped `git add` ships only with the stray relocation (A2.2), never alone.
- A3.2 (reference hashes) is the one revert that is not plain: record the five new hashes.

**PR map:** B0.1 #326, B0.2 #327, B0.3 #328, B0.1b #329: all MERGED and live-verified
(ce255ca5, 69369fee, a52ece09, 902d6af0). A1.1 #330 and A1.2 #331 MERGED and live-verified
(634accc6, 56385908). A1.3 #332 (6ed0c61f), A1.4 #333 (230e80e9), A1.5 #334 (318d98db) and A1.6
#335 (a8714bce) MERGED and live-verified; #333 and #332 each merged on a push Codex never
reviewed within 4 min (no 👀, no row), per the user's rule. A2.1 #336 MERGED and live-verified
(9152b594; Codex round 1 clean). A2.1b #337 (added mid-series: `plan/merge.ts` had its own
unmerged-path reader A2.1 missed) MERGED and live-verified (881ed64a; Codex round 1 clean).
A2.2 #338 MERGED 2026-09-26 (23523879) after 20 Codex rounds (R20 declined, loop ended);
live-verified: 60/60 merge suites inside haive-worker (git 2.54, root), `smoke:dag-auto-resolve`
DAG_AUTO_RESOLVE_OK; main synced, worker restart confirmed (tsx change line, new pid). A3.1 #339
MERGED 2026-09-26 (5f78fbb6, main CI green) after 7 Codex rounds (R7 clean); 0168 applied on the
dev DB; live-verified at zero tokens on a throwaway e2e user + real blank repo: both creates 409
naming the live task, task Retry 409, direct revive hits the index, nothing enqueued (queue is
`haive-task`, NOT `task-queue` — that name is the pre-rename leftover), rollback metadata names its
upgrade, rollback ran to completion (04 done, 0 invocations), then "last one was rolled back" 409.
Its browser check found the no-drift banner row overflowing at 375 (Open task / Roll back
off-screen) -> A3.1b #340 (worktree `banner-wrap`, e2e control `upgrade-banner-phone.spec.ts`,
verified pre-merge by swapping haive-web for host `next dev` per [[web-dep-bump-browser-check]])
MERGED (54d4977a, main CI green). A3.2 #341 MERGED 2026-09-26 (97b40f92, main CI green on the full
sha); live-verified on the dev stack: rows seeded with the per-RENDERING hash (not the item's
contentHash) converged at worker boot, older-body rows kept sha256(''). Worktree and branch
removed. A3.3 #342 MERGED 2026-09-26 (5963a699; Codex round 1 clean, 👍 no findings). Four
commits: docs, fix (12 stages settings files only through rows; 12/03 check them against
.gitignore), test (pins 07's RTK writes, green on main's 07 and the new one), refactor (07 writes
the manifest items' renderings; api reads RTK_SETTINGS_PATHS; shared literal scan, five on main).
Live-verified: real 12 apply in haive-worker on the live DB, 7/7 PASS, fixtures 0. LESSON: the
pull restarted api+worker onto source importing the new export while dist was stale, both died
(SyntaxError) for ~16 s until `bash scripts/dev.sh libs` — run libs IMMEDIATELY after pulling a PR
that adds a shared export. A3.4 #343 MERGED 2026-09-27 (4dc9a4d3; Codex round 1 clean, 👍).
`restoreIfUpgrades` (04) judges the file or region against the upgrade row's
`lastObservedDiskHash ?? writtenHash`, read BY ID at apply; a kept path still reverts its ledger
(rollback copy of the prior row, `userModified`, disk hash) and is not counted. Controls: 6 undo
cases + 3 smoke checks fail on main (smoke 53/56 main, 56/56 branch). The smoke's region edit had
removed its only real-flow untouched-region restore, so a second-upgrade region overwrite + restore
check was added back. Live: the smoke inside haive-worker on the dev DB, 56/56, fixtures 0 (dev DB
holds 0 onboarding_artifacts rows, so its global `unclaimBackfilledEdits` touches nothing real).
No shared export, so no libs rebuild; worker restart confirmed (pid 10349, ready 22:42:29).
A3.5 #344 MERGED 2026-09-27 (350078e9; Codex round 1 clean, 👍). Commits: docs, refactor
(AGENTS_MD_READ_CAP folded into RULES_FILE_READ_CAP), fix. `readUpgradeFile`
(`@haive/shared/rules-files`) answers absent only for a missing path; 01 marks the rest `unread`
under `UNREAD_HASH` (classifyEntry lost its `diskContent` arg); 02 names unread entries in an
`unreadNote` and never acts on them. DECISION switched from the plan visibly: an over-cap
conflict gets NO radio (the plan's "Keep/Skip, Keep refuses to record" made both options Skip).
Also folded in: 04 `restoreRemoved` returns restored/changed/unread, so a linked parent dir no
longer throws out of the rollback. Controls: 10 worker units + 1 api + 3 smoke checks fail on main,
and main's apply THROWS on a link at a new path (the smoke aborts). Live: smoke 59/59 in
haive-worker on the dev DB, fixtures 0. The pull hit the missing-export window again (~7 s, worker
SyntaxError 23:13:23, ready 23:13:30 after libs) — expected per the lesson above.
A3.6 #345 MERGED 2026-09-27 (fc128985; Codex round 1 clean, 👍; fix 20edb88b). 02 inserts a record
before EVERY write in its own statement: a copy of the plan's live row (its snapshot + schema
version, entry.templateId) when the disk matches it, backfillRecord/cliRulesRegionRecord otherwise,
or a MARKER (lastObservedDiskHash null; writtenContent null = file absent, '' = region absent)
where nothing stood. A retry that finds the render reuses the newest record per
`templateId\npath` (`asc(generatedAt)`, last wins). Preimages are re-stamped in the tx; a marker
only when the tx retires a non-own row at its path, so a retry PROVES the retired row by equal
supersededAt (the naive "fall back to the plan's liveArtifactId" names a row a boot migration or
reset retired meanwhile). DECISION switched from the plan visibly: 04's legacy lookup is bounded by
`superseded_at <= prior completed_at`, NOT "exclude other tasks' 02 rows" (that drops legitimate
retired rows: an earlier upgrade's own rows and keep rows). 04 detect cannot run on the fake DB
(raw SQL on tasks.metadata), so the legacy bound is covered only by the smoke. Controls: retry unit
test 4/5 fail on main; smoke 5 new checks fail on main (67/67 branch). The smoke's first clean-path
check passed on main too (moveTemplate changes only the row, so the "update" rewrote identical
bytes): fixed by giving the file and row an older version.
Live: smoke 67/67 in haive-worker on the dev DB, fixtures 0 before and after. The pull was
missed by `tsx watch` again (worker pid unchanged at 41 min), so the worker was recreated with
`scripts/dev.sh restart worker` (0 running/queued tasks, 0 live runs); new pid ready 23:55:30.
A3.7 #346 MERGED 2026-09-27 (34f647b9; main CI green). 02 records each RTK strip INSIDE the parked
edit (a superseded backfill row, template id/kind `RTK_BLOCK_RECORD` = 'rtk-block', writtenContent =
what the file held, lastObservedDiskHash = hash of what the strip left, NEVER in retiredRowIds) and
names it in `rtkBlockStrips` (last). 04 restores strips BEFORE the targets loop (a region restore
first would move the file off S and send the block to the end): whole file while it hashes to S,
else append like 07; same blocks standing = put back; other block / removed file = kept + warned.
Strip and restore refuse non-UTF-8. api `lastUpgradeRemovedFiles` renamed `lastUpgradeRemovedContent`.
Codex R1 P2 VALID (fixed d64b202b): a strip that loses a save race (ParkedFileError) leaves its
record, and the retry's 'none' branch took it for the save; a retry now reuses an earlier record
only while the file hashes to what that strip left (A3.6's rule). R2 clean (👍). Controls: fake-DB
test 6/6 fail on main, api strip-only offer case fails, smoke 5 new checks fail (50/50 branch).
Live: smoke 50/50 in haive-worker on the dev DB + a temp api script (offer true, after rollback
false), fixtures 0. This time the WORKER restarted on the pull by itself; the API did not (1h25)
and was recreated with `scripts/dev.sh restart api`.
A4.1 #347 MERGED 2026-09-27 (ec9a522a; Codex round 1 clean 👍; main CI green).
`ensureTaskScratchWorkspace` now runs `ensureDirNoFollow(REPO_STORAGE_ROOT, userId)` first (the
refresh.ts pattern); all three callers (task-queue context, both cli-exec mount resolvers) go
through it. Control: the test mocks `sandbox-identity.js` to the runner's own uid so the chown is a
no-op on CI's uid. Live: temp tsx in haive-worker on the real volume, user dir absent -> root:root
0755, scratch 1000:1000, both removed after (removeNoFollow non-recursive, UUID ids), repos root
back to 2 user dirs. The worker's tsx watch picked the pull up by itself.
A4.2 #348 MERGED 2026-09-27 (2a9e4b75), FIVE Codex rounds, every finding VALID and fixed:
(self-found) a build of an older config ending last removed the newer image; R1-P2 success claim
outside the tag's turn let a provider moving off the tag remove it just before the claim (claim now
`withImageTagLock` + existence check, removals wait out an in-flight build via `removeOnceBuilt`);
R1-P1 stale completion moved the row back (own row moves only while its config resolves to the tag);
R2-P1 the tag-based sibling fallback revived a sibling whose build of another tag failed (siblings
matched by CONFIG only, SQL selects all non-building rows); R3-P2 a superseded build's image was
never named (markProvidersReady returns `{ self, replaced }`; superseded build removes its image
unless named and answers ok:false with the reason); R4-P1 the unconditional pre-build `building`
write could land after a newer build's ready and stick (`writeWhileWanted` guards start, failure and
the no-image branch; a build already superseded builds nothing). R5 clean. Lesson: once a row stops
naming what is in flight, EVERY write and every refcount has to be re-keyed on config, not just the
claim. The fake DB has no row locks, so a race test must not rely on a paused transaction holding a
sibling (it over-models concurrency); pause at a docker call instead. Live: temp tsx in haive-worker,
throwaway user + 3 providers, scratch images (`FROM scratch` + LABEL, no network): P and the failed
config-sibling moved to T, the other-config sibling kept `failed`/`boom`, both old images removed,
T kept, the user's real providers unchanged, all fixtures and images removed.
A4.3 #349 MERGED 2026-09-27 (ec7f2b35). The boot reaper (renamed `reapOrphanedAuthVolumes`) takes a
dead task's copy, and a provider's (`p_`) or user's (per-user and `_k_`) auth volume once no row
with its id slug is left; `cliAuthVolumeOwner` beside the builders reads the owner back. Codex R1
(on ca80365f, after an `@codex review` nudge) P2 VALID: a login container left running kept a gone
owner's volume in use; login containers have no docker name or label and their `containers` row
cascades, so a gone owner's volume now gets `docker ps -aq --filter volume=` + `rm -f` first (task
copies keep stopped-only: completion can race its step-summary run). R2 clean 👍. GitGuardian
failed the first push on 3 "Generic High Entropy Secret" fixtures (names built from real local ids);
fixed by rebuilding the fixtures from patterned uuids through the builders and AMENDING + force-push
with lease (the check scans the whole PR range), incidents 37658352-4 left for the owner to mark
false positive; see [[gitguardian-fixture-false-positives]]. Live: previewed orphans = exactly the
approved 12 (two deleted users' 10 + `p_99b39acba6d1` x2) with no containers; after the pull
`scripts/dev.sh restart worker api` (shared exports changed, so libs had to rebuild before the
worker could import them) and the boot sweep logged `orphans: 12, total: 63`, removed exactly those
12 (63 -> 51, none added, no failures), worker booted without errors.
A4.4 #350 MERGED 2026-09-27 (9a4eeb44; Codex R1 clean, main CI green). api and worker dev services set
`CHOKIDAR_USEPOLLING=true` / `CHOKIDAR_INTERVAL=1000` (tsx 4.23.12's bundled chokidar reads both; tsx
watch ignores `**/.*/**`, so a probe must not live under `.claude/`). Control = a throwaway tsx watch
in the worker container over the bind mount (`packages/worker/tmp/watchprobe`, gitignored), writes
from WSL: without polling the 2nd `git checkout` of a file and every write after it were missed (2 of
the 8 writes), with polling 8 of 8. Cost: probe polling all 744 worker src+lib
files 93 ticks/60s (~1.6% of a core); live after deploy the worker watcher 89 and the api watcher 85
ticks/60s (~1.5% each). Live: both running tsx processes carry the vars, the probe with the
container's own env caught 8/8. The pull of #351 (worker source) is the real-world check.
A4.5 #351: comment-only (three identical persona-recheck paragraphs collapsed, isolation paragraph
moved to `resolveAgentDefinitionMasks`). Codex R1 clean.
A5.1 #352, A5.2 #353, A5.3 #355, A5.4 #356, A5.3b #357: MERGED and live-verified (#354 is haive-bb's).
A5.5 #358 MERGED 2026-09-27 (578ccd64, main CI green). Codex R1-R4 fixed (api repo delete before
any SQL; wait for the worker's `task.cancel_finished`; failed tasks cancelled; user kept while a
cancel is unfinished or refused; cleanup job carries env image tags). R5 (a cancel whose queue write
fails is never retried) DEFERRED to the running list: product-side, needs a dedupe design. Live on
main with NO simulator: harness + 3 migrated specs 25/25, eight row counts back to baseline.
A5.7 #359: R1 session lock → per-statement `pg_advisory_xact_lock`; R2 one long transaction held
ACCESS EXCLUSIVE through the HNSW build (reader 3,862 ms vs 7 ms per step) → a transaction per step;
R3 any `CREATE EXTENSION` failure (a failed lock included) chose the permanent jsonb table → only
SQLSTATE 0A000/58P01/42501 (MEASURED on PG 18.6: not installed 0A000, no privilege 42501), per-repo
`ensureRagSchema` too; R4 one process-global memo → a map per store (sha256 of the external
string). Each fix re-ordered before the docs commit (`reset --hard` to the last fix after parking the
head on a temp branch, cherry-pick, amend docs, `--force-with-lease=<branch>:<old sha>`).
#359 MERGED def640f0 (live: 8 concurrent first calls after an api+worker restart all 200). A2.3 #360
MERGED 5a116d43 (live: controls pass in the worker container, git 2.54 / Node 26.10). A5.6 #361
MERGED ba3fe766 (live: control spec 3/3 on haive-web). Track A5 done. The "A5.6 shipped and
live-verified (#361)" docs mark was PAID by #366 (merged 3d7473db, 2026-09-30);
Each PR opens after the one before it merges, rebased on main with its
docs commit added first, so the plan-doc banner and README row never conflict.

**A2.2 review outcomes (#338), not to re-litigate:**

- R1 P1, ignored files are outside the snapshot: remedy DECLINED and documented. They are where a
  person's running tools write; recording them hashes every dependency tree (MEASURED 43,305 ignored
  files, 835 MB `node_modules`, beside 1,972 tracked in a Haive worktree); `.env`/`.env.*` are
  already read-only masks in the sandbox. 👍 (it made the doc accurate).
- R2 P1, `git restore` writes root-owned files: FIXED with a hand-back to the merge dir's owner.
  A root-only test runs in a `node:26-bookworm-slim` container with the worktree mounted (the
  worker image is Alpine, whose musl cannot load the host's glibc node_modules): install git,
  `(cd / && git config --system --add safe.directory '*')` (from the worktree, `git config` dies on
  the gitfile's host path), then vitest. Forgetting the `cd /` fails the root-only owner hand-back
  test (`keep.txt` left as the fixer wrote it, baseline `unavailable`: dubious ownership), which
  reads like a regression; the tell is `fatal: not a git repository` printed before vitest starts.
- R3 P1, a fixer's `git add -A` reaches the commit (`commit` takes the whole index; a same-branch
  root has a working git): FIXED with an index tree from `diff-index --cached HEAD` and `restore
--staged`. MEASURED on 2.43: git refuses to open a merge while the index holds a staged change.
- R3 P2, chown only what git recreated: FIXED (`missingParents`). R3 P2, capture failure should
  halt: diagnosis valid, remedy DECLINED (a halt stops every merge whose scratch `add` fails, e.g.
  an LFS clean filter); a `{ unavailable }` baseline is reported as unchecked instead.
- R4 P2, file replaced by a directory: stated failure does NOT reproduce (MEASURED 2.43/2.54: restore
  replaces an EMPTY dir, exit 0) but a NON-empty dir is replaced too and its contents deleted, so
  such a restore is now skipped and named. R4 P2, plan-merge scratch tree force-removed on confirm:
  FIXED by recording each left link's target in the manifest and rewording the warning.
- R5 P1, a fixer's `.gitignore` edit re-decides what is ignored between the two snapshots: FIXED
  (ef09c607), both directions (MEASURED 2.43: a dropped `cache/` rule made `cache/keep` read `A`;
  an added `*.log` rule made a recorded `app.log` read `D`, and the restore wrote over a tool's
  appended line). Baseline records `ignored` = blob of `git status --porcelain=v1 -z
--ignored=matching --untracked-files=normal --no-renames` `!! ` entries (matching mode names a dir
  only when a rule ignores the dir itself; `ls-files -o -i --directory` ALSO lists non-ignored dirs
  whose contents are all ignored, e.g. `logs/`, so it is NOT exact). After-snapshot = `read-tree
<baseline tree>; add -u; ls-files -o --exclude-standard` minus baseline-ignored, added via
  `add --pathspec-from-file --pathspec-file-nul` + GIT_LITERAL_PATHSPECS (binary-safe; listings
  read latin1; gitRun gained optional maxBuffer/encoding; execFile's default maxBuffer is 1 MiB).
  26 entries/675 B/6-7 ms for 43,305 ignored files; 159-265 ms on the 39,378-file repo. Known
  gap, left: a NEW file hidden by an ignore rule the fixer added outside the conflict stays in the
  tree after the relocation restores that `.gitignore` (needs a second pass; clutter, never
  committed, no loss).
- R6 (on ef09c607): CI red on the git-status-optional-locks convention guard (a new `status`
  argv without `--no-optional-locks`; see [[worker-convention-guards-run-full-suite]]). P1
  directory/file conflicts: git reports only `foo~HEAD` (stage 2 = HEAD:foo's blob, MEASURED 2.43
  and 2.54) and stages `foo/bar`; keeping the file was undone and the dir side committed. FIXED
  (cd2fc94b): baseline `resolving` (replaces `unmerged`) = unmerged + the D/F partner found by
  CONTENT (same blob beside the moved file on its side, a tree at that path on the other side),
  never by git's `~` naming; entries cover their subtree; completeMergeHostSide stages them. The
  new test exposed a round-3 bug: stagedTree added `foo/bar` before removing `foo` ("appears as
  both a file and as a directory"), so EVERY D/F merge read as an unavailable baseline; removals
  now go first. P1 silent deletion restore: FIXED, `restored` in manifest/event/warning.
- R7 (on cd2fc94b, CI green): P1 the index reset reused the worktree predicate, so a same-branch
  fixer's staged `.haive-data/` and gitlink changes stayed in the index and were committed; FIXED
  (bc4fea7f), the reset skips only `resolving`. P2 D/F partner by blob identity alone took an
  identical, cleanly merged sibling (MEASURED 2.43: base foo=a bar=b, HEAD foo=b, theirs dirs →
  only `foo~HEAD` unmerged, bar clean); FIXED, a partner must also differ from `merge-base` on its
  side. `git add --pathspec-from-file` with an embedded repo's `vendor/lib/` adds a GITLINK
  (measured by the test), so the since-snapshot handles nested repos like `add -A` did.
- R8 (on bc4fea7f, CI green): P1 masked secrets: at a same-branch root the sandbox mounts `.git`
  unmasked (resolvers.ts ~573), and the snapshot's `add -A` made an untracked unignored `.env` a
  dangling blob readable via plumbing. FIXED (98214991): both snapshots = `add -u` + untracked
  list filtered by `secretMaskDeniesPath` (repo globs via `taskSecretMaskPolicy`, masking on OR
  off), read at each snapshot, unreadable policy → no baseline. Rejected alternative: a private
  GIT_OBJECT_DIRECTORY store (lifecycle + lost on container recreation). P1 lossy filters:
  `add` stored the clean filter's output / LF for CRLF (MEASURED 2.43, 2.54); FIXED with
  `GIT_ATTR_SOURCE=<empty tree>` + `-c core.autocrlf=false` on the snapshot adds AND the restore
  (git >= 2.40; the root test container's bookworm git 2.39 fails that one test by design).
  `configService.get` THROWS uninitialized, so the loader ignores the on/off switches entirely.
- R9 (on 98214991, CI green): P2 `core.fileMode=false` hid a fixer's chmod from `add -u`; FIXED
  (b985f04c) with `-c core.fileMode=true` beside autocrlf on the snapshot adds and the restore.
- R10 (on b985f04c, CI green; "Code scanning AI findings" check failed with `CAPIError: 400 The
requested model is not supported`, GitHub's own Autofind, not ours). P1 a plan fixer that failed or
  timed out never reached apply (resolveLlmPhase fails or re-dispatches first), and a Retry's reset
  nulls detect_output, so the next detect re-baselined over its strays. FIXED (03097b14): one tree
  per OPEN merge as a `plan_merge.fix_baseline` task event (new `plan/merge-baseline.ts`), reused by
  detect while HEAD/MERGE_HEAD match, recorded afresh when detect OPENS the merge (a re-opened merge
  of the same two commits is another tree; mutation-checked); `llm.prepareWorkspace` moves aside
  what earlier fixers left before every dispatch; Save/Pull (`integrateOrigin`, now exported for its
  test) move an abandoned conversation's leftovers aside before aborting its merge. Rejected:
  `llm.optional` (degrades no-provider and transient failures into fake "Still unresolved" passes),
  `merge_resolve_state` (another state machine's column), `tasks.metadata` (spawn input), a git ref
  (sandbox-writable). P1 execFile 1 MiB default on the fixer listings: FIXED, `LISTING_BUFFER`
  64 MiB on diff-tree/diff-index/stagedTree/ls-tree/unmergedPaths/abort listings. Found while
  testing: a `git merge` printing > 1 MiB is KILLED by execFile (MEASURED 2.19 MB for 300 long
  conflicts; left untracked files, no index change, no MERGE_HEAD) -> task A2.3 (#127).
- R11 (on 03097b14, CI green): P2 an UNAVAILABLE capture was not recorded, so after a failed
  fixer a Retry recorded a fresh tree over its strays (a staged one could reach the commit). FIXED
  (ce56fca7): unavailable trees recorded too, keyed by payload head/mergeHead (read by
  `openMergeIds`), reused; prepareWorkspace still skips them (no spurious report at dispatch).
  Accepted cost: one failed capture leaves that merge unchecked for life (no "was a fixer sent"
  tracking). P2 Save/Pull's `.catch` logged "kept" then the finally removed the worktree: FIXED,
  the settle runs BEFORE the try (a throw fails the save, worktree kept); the lookup skips the DB
  when no MERGE_HEAD. Full suite once failed 4 tests on 5 s timeouts (3 untouched git tests +
  the new 1.9 s 1 MiB test) while another session's pytest ran at 330% CPU; all passed alone, the
  re-run passed 400/400; the two heavy tests got `}, 30_000)`.
- R12 (on ce56fca7, CI green): P2 a crash between the relocation's moves and its manifest/event
  hid the moved files (next pass: tree already at baseline, null). FIXED (92f6b35c): plan first,
  write the manifest (`journal: true, complete: false`) BEFORE any move, final manifest after;
  `recordFixerLeftovers` drops a `reported` file beside it after the event insert; every
  relocation (null baseline included) first reports the task's unmarked journal manifests
  (`interrupted`); a same-run retry uses `<run>-<8hex>`. Old manifests (no journal flag) never
  re-report. P2 a staged non-UTF-8 name was reported but left staged and committed: FIXED, the
  index listing is read latin1 and unstaged via `restore --staged --pathspec-from-file
--pathspec-file-nul` (works on 2.39/2.43). Left: a FAILED unstage still commits (pre-existing,
  reported "still staged"); the warning's "none of them was committed" is then inaccurate.
- R13 (on 92f6b35c, CI green): P1 `stagedTree` decoded `diff-index --cached -z HEAD` as UTF-8 and
  wrote names back via `--cacheinfo` argv, so a cleanly merged non-UTF-8 name became a U+FFFD entry
  in the baseline index; the relocation then reverted the real path and committed the bogus one.
  FIXED (7c07fc0e): latin1 listing + `update-index --add -z --index-info` on stdin (`gitRun` gained
  `io.input`, EPIPE swallowed on stdin; MEASURED: `000000 <zeros>` removes, new paths add, 2.43 +
  2.39). Same round trip fixed in `abortMerge` (latin1 listings, `checkout --pathspec-from-file`);
  one `gitWithPathspecs` helper now serves snapshot add, unstage and abort. Audit: every other
  listed path either only reports or is refused for U+FFFD (completeMergeHostSide). Beware shell
  probes: `printf '\0100'` is ONE octal escape (`@`), which merged two --index-info records.
- R14 (on 7c07fc0e): CI red ONCE on an unchanged test's teardown (`ENOTEMPTY ... gm-named-*/.git/
objects`); the re-run of the identical sha passed (non-deterministic, by experiment); prior runs on
  the same git 2.55 passed. Writer unproven (30-commit probe on 2.54 saw no maintenance lock). Test
  commit 5a6490b0: `initRepo` (gc.auto=0, maintenance.auto=false) + teardown `maxRetries: 5`. P1
  a failed unstage still let every caller commit the whole index: FIXED 92366374, `indexHeld`
  (listing failure or unstage failure after 2 retries 250 ms apart); resolver/DAG halt and keep
  the baseline (a Retry re-ingests; the DAG Retry does not clear mergeState when no issue is
  stuck), plan merge apply/prepareWorkspace/Save throw. Found-not-fixed #4 CLOSED by it.
- R15 (on 5a6490b0, CI green): P2 `haiveOwned` missed the exact `.haive-data` name (a fixer's file
  replacing the dir was moved, the dir's entries left deleted); FIXED 9e56c48a. P2 prepareWorkspace
  skipped a REUSED unavailable tree, so a fixer after a failed one got no report; FIXED with
  `fixBaselineReused` from detect (captured-this-pass still reports nothing before its first
  fixer). Accepted: an in-pass transient re-dispatch against an unavailable tree still reports only
  at the next apply (the tree is captured, not reused, in that pass).
- R16 (on 9e56c48a, CI green): P1 a tree-side failure (mask policy, raw bytes, ignore listing,
  snapshot, diff) returned before the index pass, so staged strays were committed. FIXED 68efbb05:
  `changesSince` returns the tree side's failure; the index pass (needs only baseline.index)
  always runs; an unwritable journal with staged strays planned reports `indexHeld`. P2 a
  plan-merge takeover scanned only its own leftovers folder; FIXED, `fixBaselineOwner` from detect,
  `run.ownerTaskId` scanned too (moves + event stay on the running task).
- R17 (on 68efbb05, CI green): P2 the relocation took any name holding U+FFFD as undecodable, so a
  VALID name holding it was left, and a plan-merge confirm force-removed it with the worktree.
  FIXED 72e10e74: `diff-tree` read latin1, `utf8Name` (`buffer.isUtf8` on the bytes); coverage
  still compares the lossy form (how `resolving` was recorded). Same misdetection fixed in
  `completeMergeHostSide` (from #336: such a conflict could never commit). NOT fixed: #337's
  `fitsPromptLine` (prompt only, counted and told to find by markers; needs a detect-shape change).
- R18 (on 72e10e74, CI green): P2 a fixer's non-exec chmod (0644 to 0444/0600) is invisible (git
  records only the exec bit). Remedy DECLINED and documented: normalising to git's view widens a
  person's 0600 at a same-branch root; recording modes = full-tree lstat walk twice per fixer. Found
  while checking it, and FIXED 698f88a7: `git restore` recreated a put-back file at git's default,
  so a tracked 0600 came back 0644; `putBackMode(replaced, written)` keeps the replaced bits, never
  wider than git wrote, x follows r, special bits dropped. Also found (a 2026-09-27 fix, NOT in #338): an
  agent with the repo root mounted can write `.git/hooks`/`.git/config` that host git then runs.
- R19 (on 698f88a7, CI green): P2 snapshots started from HEAD, so a deny-listed file the MERGE ADDED
  read as untracked and was left out, while the sandbox mask (`git ls-files -z` on the tree's own
  index) saw it tracked and left it readable: a fixer edit to it went unseen. FIXED 1efed2da (denied
  names the live index tracks stay in; listing only when something is denied). P2 a cancel runs no
  relocation: DECLINED + documented 213b78ea (task worktree removed whole by design; same-branch
  root left as is, merge open; plan scratch worktree settled by next pass/Save/Pull); the
  unreported-at-root gap is in the running list.
- R20 (on 213b78ea, CI green): P2 lossy decoding can make a valid U+FFFD conflicted name and a
  staged invalid-bytes name compare equal, so the second stays staged. DECLINED (👎): needs that
  exact pair; a fixer can only stage where it can also commit (relocation then reports the merge
  no longer open); bytes in `resolving` means a persisted-shape change + compat path, and "never
  cover an undecodable name" would reset a staged resolution of an undecodable conflict to HEAD.

**A3.1 review outcomes (#339), not to re-litigate:**

- R1 (on cc277dfc, CI green): P1 a failed upgrade revived by any route (task/step Retry, Resumes,
  retry_ai, Skip, CLI switch, clarify, worker form pickup) became live beside the next. FIXED
  2970fd8e with a partial unique index `tasks_one_live_upgrade_per_repo_idx` (migration 0168; the
  precedent is `cli_invocations_one_live_per_step_idx`), mapped to 409 in the api `errorHandler`,
  read as "not pointed" by the worker's `markTaskRunningWithStep` when `reviveFailed`. The
  migration fails all but the newest live upgrade per repo first (dev had none). Allowance
  auto-resume cannot reach an upgrade task (no upgrade step has an LLM phase). Control:
  `upgrade-single-live-smoke.ts` (in smoke:ci), fails with the index dropped. 0168 is APPLIED on
  h1-smoke-pg: editing it later means deleting its schema_migrations row and the index there
  first, or the runner hard-fails on the sha.
- R2 (on 2970fd8e): Codex 👍, but CI red: `upgrade-claims-smoke` and `rtk-off-upgrade-smoke` seeded a
  second live upgrade task (fixtures left a finished rollback / planned-only upgrades `running`).
  FIXED 313a50ad in the fixtures (complete the rollback; `endLiveUpgrades` before each new task),
  never in the index; both pass locally (52 / 43 checks). See [[db-invariant-breaks-smoke-fixtures]].
- R3 (on 313a50ad, CI green): P2 the banner's live-task button lived only in the drift view; a
  rollback with no drift left read "Up to date" with no action. FIXED 4b527cd5 ("Upgrade in
  progress" + "Open task" whenever `inProgressUpgradeTaskId`). Web has no DOM harness: its three
  banner states are OWED in the browser at 375/768/1280 after merge.
- R4 (on 4b527cd5, CI green): P2 answering a failed upgrade's parked form beside a live one: the
  submit route stored it and queued the advance, and the worker's index refusal dropped it
  silently. FIXED bac0946b: submit refuses 409 first (`refuseBesideLiveUpgrade`, shared with
  `insertUpgradeTask`); a race loss in the worker records `upgrade.revive_refused`.
- R5 (on bac0946b, CI green): P2 creation committed the `created` row before the event and the move
  to `queued`; a failure between left a live-counting orphan nothing starts. FIXED 49981e72: POST
  /tasks' fallible post-insert writes run through `settle`, inside the upgrade's tx; the rollback
  route flips to queued in its tx. Api smoke:ci chain passes locally.
- R6 (on 49981e72, CI green): P2 an older release's `created` upgrade survived 0168's dedupe and held
  the index; as the newest of two it also outranked a parked upgrade, which got failed. FIXED
  00893839 by EDITING unmerged 0168 (fail every `created` upgrade first; no route makes one on
  purpose, deferStart is plan-build only). Codex's "409 indefinitely" overstated: banner's Open task
  reaches the task, whose page offers Start/Cancel. Control: new `migrate-smoke.ts` case 11 (CI's
  smoke:migrate; HAIVE_MIGRATIONS_DIR prefix corpus, then full). h1-smoke-pg re-migrated with the
  new checksum (98bb12e8...).

**A3.1 decision, switched from the plan visibly:** `latestUpgradeToRollBack` is the newest completed
onboarding_upgrade task of EITHER kind, null when that is a rollback. The plan said "newest whose
mode !== rollback", which re-reverts an upgrade already rolled back and contradicts the existing
`lastUpgradeRemovedFiles` test ("stops offering it once a rollback completes"). `insertUpgradeTask`
holds an advisory lock `onboarding-upgrade:<repo>` for the live check + insert; the web's "Continue
upgrade" now opens `inProgressUpgradeTaskId` (it used to POST a second upgrade task), and Roll back
hides while one runs. Web browser check is owed at the post-merge live check.

**A3.2 decision:** per-item `referenceCtx` (shared `TemplateItem`); rows converge inside
`syncTemplateManifestCache`'s transaction (savepoint; a failed convergence logs, never fails boot).
New hashes (a revert must set these back to sha256(''), or every converged row reads as changed):
marketplace.json 79cb5c97…d2ae, plugin.json c1835976…e48e, .lsp.json 8118624e…4bab,
rtk.claude-settings 4b9de382…be1b, rtk.gemini-settings 84d030ea…0480 (full values in the PR body).

**A2.2 design, measured 2026-09-26 (git 2.43 host, 2.54 worker, identical):** baseline = the
whole worktree as ONE tree via a scratch index (`GIT_INDEX_FILE=<tmp> read-tree HEAD; add -A;
write-tree`), plus `unmerged`, `HEAD`, `MERGE_HEAD`. Cost on the largest repo here (39,378 files,
582 MB): 1.82 s cold, 0.19 s warm. `diff-tree -r -z --no-renames B A` names exactly the fixer's
changes; `git restore --source=B --worktree` puts back staged, untouched, deleted and the
person's dirty files without touching the index. TRAP: `merge --abort` REFUSES right after that
restore (stale index stat data, "not uptodate"); `git update-index -q --refresh` (exit 1 on the
unmerged path, harmless) fixes it. `git worktree remove` without --force keeps a tree with an
untracked file and deletes ignored files. The baseline is spent (nulled) right after relocating,
before any halt, and relocation refuses when HEAD/MERGE_HEAD moved: comparing a stale baseline
with a post-abort tree would restore merged files into a tree with no merge open. Local-path
repos are mounted read-only into the sandbox (`resolvers.ts:544-554`), so under HOST_REPO_ROOT
nothing is captured. Real repos here: 9,251-file roots hold 117-196 untracked files (uncommitted
onboarding output), which `add -A` at a same-branch root used to sweep into the merge commit. Live-check scripts must also delete the `user_invites` row they insert (five were
left behind before this was caught). A live check that calls worker code directly runs it with
`node_modules/.bin/tsx --eval` inside `haive-worker` (no bash there, only `sh`); the eval is CJS,
so wrap it in an async IIFE with dynamic imports.

**A2.1 measurements (git 2.43 host, 2.54 worker, identical):** `diff --name-only --diff-filter=U`
C-quotes `a"b.txt` and `café.txt`, `-z` does not; MERGE_HEAD equals the merged ref's sha on a
conflict; a fixer edit to a cleanly merged (staged) file makes `merge --abort` exit 128 with
MERGE_HEAD kept, and restoring that path from the index lets a second abort succeed; a refused
merge (local change, untracked file, bad ref) leaves no MERGE_HEAD and "not something we can
merge" exits 1, the same code as a conflict; `merge --abort` with no merge open exits 128. The
worker's `/host-fs` is mounted rw (compose line 191), the api's `:ro`.
Merge-order note: PRs that each add a smoke to `smoke:all`/`smoke:ci` conflict on those lines;
the second rebases.

**B0.1 design, not to re-litigate:** a server counts as Haive's only when its definition is
DEEP-EQUAL to Haive's default under that name (a name alone is spoofable); the whole held list
moves to `tooling.importedMcpSettingsJson` (the runtime still gets Haive's managed servers from the
generator); consent keys (`ONBOARDING_TOOLING_CONSENT_KEYS`) are stripped from the incoming file
and from what 12 commits; accept records `acceptedMcpSettingsMark`, an HMAC keyed with the
install's encryption key (a plain sha256 was forgeable by a committed file, Codex P1 round 1), so
the every-boot repair converges; the accept/discard decision is a PATCH of its own (400 when mixed
with other fields, Codex P2 round 2); the repair treats a column as local when it deep-equals some local
`04-tooling-infrastructure` `output.tooling` (04 and the import are the column's only writers).

**B0.2 review decision, not to re-litigate:** Codex P1 on #327 (task activation does not honor the
refresh claim) was answered with AGENTS.md wording, not a gate: the same task-queue gate was built
and abandoned for the reset (writer 1), and for refresh the window loses nothing. Logged in the
running list to revisit after A1.1/A1.4.

**B0.3 review decision:** Codex P2 on #328 (rows imported before the fix keep `rtk_enabled`
true) was NOT repaired by a migration: the tooling PATCH writes the column alone, so "never
touched" and "switched back on" look the same and a repair would have to choose. Recorded as a
B1.5 obligation in `two-install-project-sync.md` (ask, never choose). 0 such rows on this install.

**B0.1b review decision:** Codex P1 on #329 (the apply re-read could record servers added after
the form) was fixed with a fingerprint from ONE detect read and a refusal at apply before any
write; recording the detect-time definitions was rejected (the person reads the file, which can
be later than detect).

**A1.3 design, not to re-litigate:** requeue only while `getWorkersCount()` reads 0 (fail closed
on error); every task job, but on cli-exec only INVOKE and REFRESH_VERSIONS (the rest keep the
30-min lock path, as before); a per-job counter (`haive:boot-requeue:<queue>:<id>:<timestamp>`,
limit 3) because `moveToWait('0')` never counts toward `maxStalledCount` and a worker-killing job
would otherwise loop at every boot. tsx watch and compose both let the old process exit before the
new one starts, so no overlap can requeue a job a live process is finishing.

Related: [[found-not-fixed-running-list]], [[found-not-fixed-sweep-2-series]],
[[haive-pr-workflow]].

**Track A closed out 2026-09-27.** Every A item merged and was live-verified; the queue's next
item is Track B phase 1 (#105 B1.1 onward).

- **The A5.6 docs mark is PAID**: #366 (commit 6b6e31b2, merged 2026-09-30 as 3d7473db) set the
  plan banner and README row to "A5.6 shipped and live-verified (#361)".

**The 2026-10-01 tail: entries relayed by the AIDE² and RAG plan sessions, one PR each.**
D8 #368 (learned guidance states its cap; Codex 3 findings, all valid: a saturated scan says
"possibly more", repository scoping moved into the SQL, a drop that leaves nothing logs). Mermaid
import timeout #369. F15 #370. NUL bytes #371 (keys built with `JSON.stringify`, plus a guard over
every tracked text file). RAG F14 #372 (comment only; the pool stays 40 until RAG plan P3).
D7 #373, MERGED 54928137, migration 0169: the USER decided "This task, with a way to keep it" — a
step's CLI picked during a task is `task_step_cli_choices`, read first by every resolver; the user-wide
preference changes only with `remember` ("Also for my later tasks"). Codex rounds, all valid: the
provider FK must be `SET NULL` (a cascade resurrected the saved preference), a cleared slot shows no
stale effort, and 09_6's "CLI for the fix" must write the task choice (it still wrote the user pref).
F14 #374, MERGED 6aa6c3c9: an agent patch must carry `expectedVersion` for every existing node it
changes or deletes (`requireExpectedVersion`, set by `applyAgentPatch`; an ordinal-only reorder is
exempt, MEASURED 1,350 unversioned sequencing upserts), plan chat sees versions; Codex P1, valid: a
non-leaf agent delete cascaded past descendants' versions, so an agent deletes leaf by leaf. F16 #375,
MERGED 51cc3bd7: the leave-to-a-person arm of D10, `tooWideToSequence` = more than half a patch,
shared by the fan-out and the Order count; the slicing arm was not taken; live-verified zero-token.
postgres.js #376, MERGED cdfdcc43: the upstream #1209 patch via `patchedDependencies`, `end({timeout:
5})` at the five one-job pools, `smoke:pg-drop`, Dependabot ignores postgres (`ERR_PNPM_UNUSED_PATCH`).

**Track B started 2026-10-01.** B1.1 #378 (two-install smoke): Codex round 1 P2, VALID and wider than
it said: 07 reads 01/02/04/06_5 step OUTPUTS, not the repo columns the smoke seeded, so A rendered an
empty context and wrote NO agents (resolveAgents returns only accepted ids). Fixed in 8226ef84: real
01→02→04→06_5→07→12 on a Drupal fixture (composer.json with drupal/core-recommended), ctx carries the
provider id (else LSP is forced off), first check asserts A's render context, the B1.4 gap compares
B's renderCtxSnapshot framework/agents/LSP to A's. 17 checks, 4 gaps, 35 paths on A.

**Codex's allowance ran out at 2026-10-01 07:06Z but was back the same day**: it reviewed #375, #376
and #378 (👀 then a review or 👍). Greptile reviewed nothing in October. Run the normal Codex loop
while it answers; fall back to CI-only only on a fresh usage-limit comment ([[haive-pr-workflow]]).

**Track B, 2026-10-01 after the Sonnet 5.5 restart.** The ledger with every brief, verdict and
decision is `/home/activit/haive/.claude/tmp/track-b/ledger.md` (git-ignored); read it first.

- B1.1 #378 MERGED a490423c. B1.2 #379 MERGED 4e2d5810, live-verified.
- **F17 #381 MERGED 21c9d88c, DONE**: main CI green, `pnpm docker libs` then `pnpm docker migrate`
  applied 0170 on the dev stack — rows holding `__` keys 10 to 0, and the md5 of every row minus
  those two keys identical before and after. Worktree removed. NOTE: the worker had died on the
  missing `mirroredEnvDetectData` export between the pull and the libs rebuild
  ([[worktree-resolves-shared-from-main-checkout]]); rebuild libs right after pulling a shared change.
- **B1.3 #380 MERGED 42617650** after 13 Codex rounds (round 13 clean).
- **B1.4 analysed by three Opus analysts** (notes in `.claude/tmp/track-b/b14/analysis/`), design
  decided and recorded in the ledger's "Next" section. The headline: B cannot derive the render
  context, because the accepted agent ids and custom agent specs exist only in A's database, so A
  must commit `format.json` + `project/render.json`; settings and environment stay out until B1.8,
  because PATCH /tooling and PATCH /exclusions rewrite no file and the record would go stale.
- **B1.4 split in three PRs** (B1.3 alone took 13 rounds): **B1.4a #384 MERGED 8f97f9c3** (migration 0171,
  column schema, writers 12/02/04; dev DB migrated); **B1.4b #388 MERGED a919d6e4** (the checkout sync,
  `project-state/sync.ts`; base = the CHECKOUT's record, not the merged one; tree capped 4,096 entries /
  16 MiB; local rendered through the codec; round 1 clean); **B1.4c in design** (2026-10-01: Opus analyst on
  `.claude/tmp/track-b/b14c/design-brief.md`, worktree `project-state-sync-c`). Per-sub-PR ledgers live in
  `.claude/tmp/track-b/b14b/` and `b14c/`.
- Paused 2026-10-01 (weekly usage) and RESUMED 2026-10-02 on "let's continue".
- **#169 DONE**: PR B **#392 MERGED 72bfb717** after 5 Codex rounds (each a valid Stop/liveness gap:
  recheck after the DDEV boot, then at the helper's return, then at `ensureAppServing`'s return; and the
  smoke re-ensures before probing because gate 2 defaults to reject on a failed smoke). Main CI green, dev
  checkout pulled, worker restarted on it. Live DDEV check OWED (mocks only).
- **B1.4 DONE** (2026-10-02): B1.4a #384, B1.4b #388, and **#393 MERGED 9beb7507** (B1.4c + B1.4d + #227 +
  #229 + the obsolete keep choice + the untrack-restore rollback + boot `recomputeSyncedApplicableSets`)
  after 7 Codex rounds (R7 clean 👍), main CI green. B1.4e (#226) SUPERSEDED: the applicable set is the
  RENDERED set at every writer, and the banner reports a claim outside it while 02 could act on it.
  Live check PASSED on the dev stack: folder-imported clone, column filled, banner "not upgraded on this
  install yet" at 375/768/1280 with no overflow, 01 planned 4 new_artifact from the column, 02 parked.
  Everything cleaned up, and all four worktrees removed (ref code archived in b14c/ and b14d/evidence).
- **PARKED 2026-10-02 until next week (user: weekly limit).** On resume, nothing is in flight. Next:
  B1.5+ in plan order, then the FNF tasks. OWED live checks: #392 DDEV liveness/Stop (mocks only), and
  B1.4d with a real teammate render change across two clones (design-227 live check, steps 0-7). The
  live-check script is `.claude/tmp/track-b/b14c/b14c-live.mjs setup|status|upgrade|cleanup`; its
  fixture came from a patched copy of two-install-smoke that saved install A's bare origin, plus a
  KB/skills stand-in commit.
- **Host C: had 15.1 GB free on 2026-10-02** (vhdx sizes unchanged since 09-25; the loss is Windows-side).
- **Per-unit legacy fallback is now the rule**: a partial record must not switch the legacy
  `environment/tooling/exclusions.json` import off, or B loses them.
- Open, verified by reading, for a fix PR after B1.4: neither upgrade gate reads the reset epoch
  (a reset repo can still be offered an upgrade), an upgrade can start while onboarding parks at 13,
  and with no file-based agents dir 07 writes `.claude/agents` while 12 records `agentTargets: []`,
  so no upgrade ever manages those files.

**Status 2026-10-13:** phase B1 complete — B1.5 #585/#588/#599/#593; B1.6 #608/#610/#614/#617/#619/#623 (+B1.6g #626); B1.7 #628/#629/#630/#631; B1.8 #632 (outbox, migration 0194)/#633/#634/#635/#636. Briefs+reports per sub-phase in `.claude/tmp/track-b/b16|b17|b18/`. B1.8 decisions (D1-D10, in b18/brief.md): app-auth + verify_commands machine-local; only rtk-enabled conflicts block upgrades; legacy mirrors retire only once the sync imports their unit; an unrecorded RTK choice never travels; tooling is one whole-value fill-if-absent unit. Codex skipped 2026-10-12/13 by the user (quota) — #608-#637 merged without Codex; a full-repo Codex-like pass is owed after the series. Codex BACK 2026-10-13 (user): resume the review loop from #638 on. Open FNF: #264 descriptor flap, #266, #267, #268, #269.

**Status 2026-10-15 (session 3813bbf6):** merged today #746 (#268), #754 (#267, 12 Codex rounds), #772 (#292, live-verified). In review: #751 (B3.1b-2), #775 (#294 -> docs-only). Building: #287, #284. Decided, waiting: #274 B3.1c (after #751), #117 B3.2 (D13-D16), #285 (D9-D11, after #284). Then B4.1/B4.2 (#118/#119), B5.1-B5.3 (#120-#122), and #275 (the full-repo review pass owed after the series).
