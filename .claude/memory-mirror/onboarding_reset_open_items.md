---
name: onboarding-reset-open-items
description: 'Found-not-fixed list for the onboarding-artifact reset (PR #181), to re-surface when that area is touched'
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-21T13:10:02.977Z
---

Open items from PR #181 (`DELETE /repos/:id/onboarding-artifacts`, merged/landed 2026-09-20).
Each was verified in the code and left deliberately. Surface these per
[[found-not-fixed-running-list]] whenever the reset, onboarding artifacts or the quarantine are
touched again.

**PR #182 (`fix/reset-survives-other-writers`) MERGED 2026-09-20 as `7bb76791`, 45 commits,
after ~30 review rounds. It closes the write-race item below and more.** Do not re-plan that one without reading it. What it established, which is not obvious
from the code alone: there are FOUR writers against a repository root, not one, and the guard
covers one of them. The fix is a RECIPROCAL, renewable `repositories.root_claimed_at` claim taken
by the reset, the three repo-queue handlers that `rm -rf` (plus `handleExtract`, which replaces
the root by rename rather than delete), the knowledge-file editor and `mark-onboarded`. TWO lock
designs were built and abandoned first — a task-queue gate stalls the whole installation, and a
repo-queue lock deadlocks the `max: 10` pool the repo and task workers SHARE. Renewal is tied to
`release()` and must never get an elapsed-time cap; one was added and reverted, because any
deadline expires a holder still rewriting the tree.

What the review turned it into, which the original plan did not anticipate: ownership is an
explicit TOKEN (`repositories.root_claim_owner`, migration 0163), not a timestamp. A millisecond
cannot identify a claim — two callers can generate the same one, and the collision is likeliest
exactly when it matters, because a takeover lands in the same moment as the renewal it races. All
five places that ask "is this claim mine" now key on the token: the claim and renewal
reconciliations, both conditional writes (`renewRootClaim`, `releaseRepositoryRoot`, whose
predicates admit a NULL owner so pre-column claims still work), and the release classification.
Do NOT "simplify" any of those back to a stamp comparison.

**PR #183 (`feat/onboarding-hash-claims`) MERGED 2026-09-21 as `d188c357`**, 7 commits, closing
the hash gap for `07-generate-files` only. Codex passed it with ZERO findings on round 1 and CI
was green on both workflows. Design facts in [[onboarding-hash-claims-design]]. Two items it
leaves:

**PR #185 MERGED 2026-09-21 as `5fa6a054`** — 09_5 and 09_5b now record hashes too, so the reset's
hash gap is closed everywhere except `11d-skill-sync`, which stays out deliberately. Codex passed
it with ZERO findings on round 1. Design facts in [[onboarding-hash-claims-design]].

**PR #184 (`--no-verify` on the onboarding commit) was CLOSED UNMERGED**, after two rounds found
two valid holes in one predicate. Do NOT re-attempt it as a flag: the bypass is per-COMMIT while
ownership is per-HUNK, so each refinement closes one hole and leaves the next. Round 1 — the
commit is pathless and `git add` adds to the index rather than replacing it, so a user's
PRE-staged work had its hooks skipped. Round 2 — a curated path carrying an UNSTAGED user edit is
swept in by the same add, `AGENTS.md` being the worked example since 07 appends to it. A
TWO-COMMIT SPLIT (hash-claimed paths with the flag, everything else without) is the only shape
that is actually correct, at the cost of onboarding producing two commits.

- **Two bundle items declaring ONE skill id — CLOSED in PR #188, structurally.** Recorded here
  first as "count fixed, cause left", then fixed properly when review found the second consumer.
  `loadBundleSkills` pushes every valid item with no id dedupe and `custom_bundle_items` enforces
  uniqueness only per (bundle, source path), so both entries wrote the same `<dir>/<id>/` and both
  landed in `written` — making the skill count, the sub-skill total, a log line AND the README
  index (a repeated table row) all wrong. 09_5 now dedupes where it READS the detect payload, so
  a payload persisted with duplicates is handled on replay; it keeps the LAST occurrence, which is
  what makes the tree byte-identical, since the later write is the one that survived the
  overwrite. The recap's own uniqueness guard was REMOVED rather than kept beside it — two guards
  would hold the visible count right while the index went wrong. The lesson worth keeping: four
  counts read one array, and patching them one at a time took four review rounds; enumerating the
  consumers after the SECOND instance is the rule this repo already applies elsewhere.

- **A commit hook makes Haive's own files read as EDITED, in BOTH claim tiers — PRE-EXISTING and
  not fixed.** `12-post-onboarding.ts:722` runs `exec('git', ['commit', '-m', message])` with no
  `--no-verify`, and VERIFIED there is no `no-verify` or `core.hooksPath` anywhere in
  `packages/worker/src`. So a repo with husky/lint-staged/prettier reformats the files 07 wrote
  four steps earlier, IN THE SAME RUN. The row tier has had this since it shipped, because
  `artifactMatchesDisk` compares a manifest RENDERING hash against disk; #183 extends the same
  exposure to the step hash. `normalizeContent` absorbs CRLF, trailing whitespace, blank-line runs
  and the final newline — NOT table padding, JSON re-indentation or re-wrapped prose, and
  `agentsIndexMarkdown` emits a markdown TABLE. Left deliberately: the right first move is to
  MEASURE how often it fires, which is exactly what #183's new `edited` reason enables, and
  bypassing a repo's own hooks changes what lands in the user's tree. In the PR body but NOT yet
  in AGENTS.md — fold it in with the skill-generator PR, which touches that section anyway.
- **`quarantined[].reason` is returned but never rendered.** `tasks/new/page.tsx:438` prints
  `from → to` only; the `skipped` channel at `:442` does render its reason. One-line web change,
  left out because #183 was scoped to the api. The user was offered it before the push and chose
  to ship without it.

- **A release that fails ENTIRELY is not observable, deliberately (PR #182).** After the bounded
  retry and every candidate are exhausted, `release()` returns normally with the row still
  claimed, and callers `.catch(() => undefined)` anyway — so a job reports a clean finish while
  the repository refuses resets, rebuilds and knowledge saves until the stale window expires.
  That window IS the designed backstop for "the holder could not clean up", and the refusal
  message names what holds it, so the state is visible to a person even though it is invisible in
  the logs. NOT fixed: `lost()` covers a takeover and a second accessor for this would add
  surface to a branch already very deep. If it is ever worth closing, the shape is an error-level
  log at the exhausted-retry point, not a new return value — the callers all discard it.

- **The root-claim "ambiguous write" family is CLOSED — audited, not just patched.** A conditional
  write that COMMITS and then loses its acknowledgement is indistinguishable from one that never
  ran, and review found that three times one call site at a time (renewal, then the recovery
  renewal, then the initial claim). On 2026-09-20 I enumerated the surface instead of waiting for
  a fourth: there are exactly THREE conditional writes to `repositories.root_claimed_at` — claim,
  renew, release — and each now resolves its own outcome by reading the row back
  (`claimRepositoryRoot`'s reconcile, `renewReconciled`, `releaseReconciled`). The release was
  the one I found myself, and the worst: it threw out of `release()` where every caller swallows
  it in a `.catch()`, so a clear that never landed blocked the repository for a whole window
  while the job reported a clean finish — and it aborted before the candidate fallback built for
  exactly that case. Load-bearing rules if this is revisited: an unproven answer always carries a
  NON-NULL stamp, so test `proven` before the stamp; candidates are a SET
  (`createCandidateStamps`) because ambiguity composes; and `lost` is never concluded from an
  answer nothing proved.

- **A run that writes artifacts DURING a reset walk keeps rows for files the walk may delete.**
  New interaction as of PR #182's snapshot scoping (`supersedeResetArtifacts` retires only rows
  the reset saw before it started). A concurrent onboarding run reaching `12-post-onboarding`
  mid-walk writes rows that survive — correctly, since retiring them would leave a just-onboarded
  tree with no provenance — but the walk may since have deleted the files they name. This is
  writer 1, the residual window AGENTS.md already documents as deliberately open, not a new
  defect: two writers on one tree is what the root claim cannot cover here, because task
  creation does not take it. Do NOT "fix" it by widening the supersede, which is the trade that
  was just made in the other direction. AUDITED 2026-09-20 and left.

- **The "vacated path keeps a live row" family is CLOSED — audited, not just patched.** Review
  found it three times one call site at a time (recursive delete, then the settings delete plus
  the quarantine rename, then a renamed directory's descendants), so on 2026-09-20 I enumerated
  every mutation site in `resetOnboardingArtifacts` rather than waiting for a fourth. Seven
  sites; three record into `vacatedPaths`, and the other four are safe for stated reasons:
  `stripHaiveContent`'s delete-when-empty acts on ROOT-level rules files, whose parent can never
  appear in `skipped` (that would need `''`), so their rows supersede normally; the swept-dir
  removal runs only when `left === 0`, meaning every child already went through `remove()` and is
  recorded; the emptied dot-dir `rmdir` has nothing beneath it. The exclusion is now whole-segment
  PREFIX matching, so a vacated directory carries its descendants — that is the shape fix, and it
  is what makes a fourth instance structurally unlikely rather than merely unobserved.
  Load-bearing assumption if this is revisited: artifact rows name FILES, never directories —
  VERIFIED 2026-09-20, structurally rather than by inspection: `disk_path` comes from a
  `TemplateRendering`, and `onboarding_artifacts.written_hash` is NOT NULL and is a hash over
  content, which a directory cannot have.

- **One `onRemoved` branch is untested: an EMPTY directory removed NON-recursively.** That path
  (`removeNoFollow`'s `st.isDirectory() && !opts.recursive`) fires `onRemoved(safe)` and the new
  `fs-safe-write` case does not reach it — its non-recursive cases are a file and an `ENOTEMPTY`
  failure. Deferred with the comment fixes below rather than pushed, for the same reason: a
  one-line test is not worth restarting CI and Codex on a PR this many rounds deep. The threading
  itself was re-checked by hand across all seven call sites and is correct.

- **Two stale comments in `mark-onboarded` (`repos.ts`), found by my own pass, NOT yet fixed.**
  Held back rather than pushed, because a comment-only commit would have restarted CI and Codex
  on a PR already 13 rounds deep; fold into the first follow-up PR, which touches the same
  provenance code. (a) The block above the reset guard still says stamping such a repo would
  hand back the state "with no live artifact rows behind it" — written before post-reset artifact
  rows became a legitimate basis for that stamp, so it reads as forbidding what the code below it
  permits. (b) The `artifactsSinceReset` comment claims "the same test `resolveOnboardingVerdict`
  uses"; the route's `completedSinceReset` requires `resetAt !== null` and the verdict's does not.
  No behavioural difference — the route only consults it under `if (resetAt !== null …)` — but the
  definitions differ and the comment invites treating them as interchangeable.

- **The `partialRemovals` wiring has no test, deliberately (PR #182, round 10).** The pure
  predicate `resetTouchedNothing` is mutation-tested, but the one line that increments the
  counter (`remove()` in `repos.ts`, `if (recursive && verdict === 'io')`) is covered by
  inspection only. A genuine mid-recursive-delete IO failure cannot be provoked honestly from a
  fixture: the obvious `chmod 000` descendant collides with `removeNoFollow`'s
  `repairPermissions: true`, and per [[ci-uid-differs-from-dev-host]] such a fixture would pass
  on this host and mean nothing on the runner. Stated on the PR rather than papered over.

- **`.claude` entries the user owns are LEFT and reported (CLOSED — this entry used to say the
  opposite and was WRONG).** VERIFIED 2026-09-20 in `repos.ts`: the sweep removes an entry only
  when `claimSatisfied(rel)` holds, and anything else takes
  `skipped.push({ reason: 'no record that Haive wrote it' })` and stays on disk. A person's own
  `commands/`, `settings.local.json` and hooks therefore survive. They are LEFT rather than
  quarantined on purpose — `.claude` survives the reset anyway, so there is nothing to move them
  out of the way OF. The earlier wording here described the pre-sweep route and was repeated into
  a "verified" found-not-fixed list without re-reading the code; re-read before re-raising it.
- **A step RETRY started mid-reset can still have its files deleted — STILL OPEN after #182, and
  deliberately.** The guess recorded here ("a shared per-repository lock taken by the reset route
  and the retry/start paths") was investigated in #182 and is WRONG twice over: there are at least
  eight revive paths and the list grows, and `autoResumeFailedStep` revives a task from the WORKER
  with no API call at all. Gating the task queue instead was built and abandoned — concurrency 5
  is installation-wide, `close(true)` abandons blocked jobs under a 30-min BullMQ lock, and a gate
  throw reaches `markTaskFailed`. It also buys little: MEASURED by reading every branch, between
  job pickup and `markTaskRunningWithStep` nothing writes a path the reset deletes, so the window
  carries no data loss. Leave it unless that changes.
- **`.claude/onboarding-review.md` survives a reset (CLOSED — leaving it is right).** `11-final-review` writes it
  (`11-final-review.ts:265`) but it is in no `wroteFiles` and carries no artifact row, so the
  claim rule leaves it and reports it. It is a record of a past run, so leaving it is arguably
  right — but it IS a change from the old whole-`.claude` delete. VERIFIED 2026-09-20;
  `.claude/upgrade-reviews/` appears only in AGENTS.md prose and in no code, so an earlier
  version of this entry naming it was wrong.
- **Sub-skill files are MOVED, not removed, wherever the slugs were not recorded**: a skill
  `09_5b-skill-repair` rebuilt (it records none), and any `09_5` output written before
  `subSkillSlugs` existed. Claiming the directory without naming what is inside would make it
  read as wholly Haive's and delete a file the user put there, so the quarantine is the
  deliberate trade. Clutter, in the direction that loses nothing.
- **`11d-skill-sync` is deliberately not a provenance source**, so a skill a workflow generated
  is quarantined rather than removed. It writes into the task's WORKTREE, and nothing in the
  step rows proves the work was merged into the root — `12-worktree-cleanup` permits `keep` and
  `remove_only`. Adding it was tried and reverted in review; do not re-add without a merge
  signal.
- **The VERDICT half is now browser-verified (2026-09-21); the reset WALK is still owed.** After
  #182 merged I checked the epoch's effect on a throwaway blank repo: markers created by hand,
  source added, epoch toggled, everything else held constant. `/repos` flips between the "not
  onboarded yet" badge and none; the New Task page flips between "Not onboarded · Will run:
  onboarding" and "Onboarded · Will run: workflow". Repo deleted afterwards. TWO traps worth
  keeping: a BLANK repo with no source sets `nothingToOnboard`, which suppresses the badge
  entirely — so a blank repo is useless as a subject and the first run looked like a failure when
  it was correct; and `/repos/:id` redirects to the PLAN tab, which surfaces no onboarding state,
  so the second surface is `/tasks/new`, not the repository page. What is still NOT verified is
  the reset WALK itself — what it removes, keeps and quarantines — which needs a really onboarded
  repo, per the item below.

- **No end-to-end browser run of the reset — DO IT ON THE FIRST FULLY ONBOARDED REPO.** The user
  offered (2026-09-20) to reset any of the current test repos once their runs conclude.
  A synthetic repo is NOT a substitute and was deliberately declined: the verdict only needs
  markers on disk plus "no onboarding task was ever started here", so a blank repo can be made
  to read `onboarded` with zero steps — but then I would be writing the `task_steps` rows
  myself, from the same assumptions the code makes. The assumptions are the thing to test: that
  real outputs carry `wroteFiles` (07), `skillTargetDirs` + `repaired` (09_5b) and
  `written[].mirroredDirs` + `subSkillSlugs` (09_5). Two of those were wrong in review
  (11d's shape, missing slugs) and a synthetic fixture would have confirmed both mistakes.
  A PARTIAL real onboarding does not work either: parked at `waiting_form` the task counts as
  LIVE, and cancelled it leaves "a task was started here" with none completed — not onboarded
  either way. Only a COMPLETED run gives the verdict.
  What to check: click Re-run onboarding, read the dialog, accept; then confirm the response's
  `removed`/`skipped`/`quarantined` render, that `-legacy` holds what was moved, that a file the
  user owns under `.claude/` survives, and that the page flips to "Not onboarded". Note the dev
  stack serves MAIN, so do this after the branch is merged and main is pulled.
