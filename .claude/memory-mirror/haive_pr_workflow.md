---
name: haive-pr-workflow
description: 'Haive work lands through a pull request now, not straight to main — the direct-to-main era ended with v0.2.0-rc.1'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6d68d1e2-9a2b-4dab-ab87-0b40403cee4c
  modified: 2026-10-18T00:59:26.126Z
---

For the Haive repo, land work through a branch and a pull request. Stated by the user on
2026-09-10, replacing the direct-to-main permission they gave on 2026-08-21.

**Why:** two reasons, both from the user. A PR gets a **greptile peer review scan**, which a push to
`main` does not — that is the point of the change, not process for its own sake. And the project has
left the phase the old rule was scoped to: the old memory said "revisit if the project reaches a
release", and `v0.2.0-rc.1` is that release — the first version usable end to end by someone who did
not build it. Modularity (`serialized-chasing-thacker`) is the first work to go through it.

**How to apply:** branch, commit, push the branch, open the PR — the harness default ("if on the
default branch, branch first") applies again, so nothing special is needed to restore it. Commit
hygiene is unchanged: still split unrelated concerns, still verify each commit is independently
green. CI runs on `pull_request` as well as `push`, so a PR is gated the same way.

**Merge with a MERGE COMMIT, never a squash.** Stated by the user on 2026-09-11: a branch here
routinely carries several unrelated fixes — that day's PR held cost accounting, ripgrep config,
framework detection, a form-validator strip and an agent-discovery change — and each commit is
written to stand alone with its own measurements and reasoning. Squashing collapses them into one
message that can only describe a fraction of it, and destroys the ability to revert or bisect a
single fix. So keep the commits; split unrelated concerns into separate commits precisely because
they will survive the merge.

**A merge deletes the branch on this repo, `--delete-branch` or not.** The repository has
`delete_branch_on_merge` switched on: MEASURED on #102 (2026-09-15), `gh pr merge --merge` without
`--delete-branch` was followed 3 s later by a `head_ref_deleted` timeline event attributed to the
user. Nothing is lost, since the head commit is a parent of the merge commit on `main`, and GitHub's
Restore branch brings the ref back. So never tell the user a branch will be kept after merging
unless that setting is off; the local checkout is left on the branch with its upstream gone.

**GREPTILE IS OFF UNTIL 2026-10-08.** Stated by the user on 2026-10-02: "Greptile won't be active
until 8th, so don't bother with it, only Codex reviews now." Until that date, do not wait for or
check Greptile on any PR; Codex is the whole review gate. From 2026-10-08 the quota rule below
applies again. MEASURED 2026-10-08: PR #433 (opened 08:01:46Z) had no `greptile` check run, comment or
review by 08:17:20Z, so under that rule Greptile counts as spent for October unless one shows up later. CORRECTED the same day: a `greptile-apps` "Greptile Review" check run started on #440 at 12:47Z, so Greptile IS active in October. Before merging, wait for that check run to complete and for `mergeStateStatus` to read CLEAN (UNSTABLE means a check is still running); #440 was merged early by mistake. MEASURED 2026-10-09: no Greptile check run or review on any push between ~19:15Z 2026-10-08 and ~10:30Z 2026-10-09 (PRs #451, #452, #455, #456), so those merged with Codex alone under the 15-minute rule; CORRECTED the same day: Greptile reviewed #459 at ~10:35Z, so it was paused, not out of quota. A gap is not proof the quota is spent; check each new push.

**GREPTILE OUT OF ALLOWANCE, 2026-10-24** (user): skip it; Codex alone is the review gate until it is back, and with Codex out too, merge on CI alone. See [[pr-watch-codex-first]].

**GREPTILE HAS A MONTHLY QUOTA — NO REVIEW WITHIN 15 MINUTES MEANS IT IS SPENT.** Stated by the
user on 2026-09-13: the plan allows 100 reviews a month and this repo had used 98. A spent quota
looks exactly like an uninstalled app — MEASURED the same day on PRs #91–#99, the only apps producing
check runs were `gitguardian`, `github-actions` and `github-advanced-security`, with no `greptile`
check run and no Greptile comment on any of the nine — so that absence is NOT evidence it was
removed. The user's rule: wait at most 15 minutes after a PR is opened or pushed; if Greptile has not
reviewed by then, treat it as out of usage for the rest of that month and proceed on CI alone, with
no further waiting on later PRs that month (a glance at the check-run apps when CI lands still
catches a review that does arrive). The quota returns with the next month, so the verdict does not
carry past the month's end. Everything below describes how to read a review when one arrives. One
call shows whether it started:

```bash
gh api repos/martinambrus/haive/commits/<sha>/check-runs --jq '[.check_runs[].app.slug]|unique'
```

**A GREEN CI DOES NOT MEAN GREPTILE IS HAPPY — its findings are comments, not a gate.**
`Greptile Review` shows up in `gh pr checks` like any other check, which makes it look like a
gate, but it is a GitHub App check run and not a workflow in `.github/workflows/` (the repo has
only `ci.yml`, `platform-checks.yml`, `release.yml`). MEASURED on PR #88: on its FINAL head sha
the check concluded **`success`** while its own `output.summary` read "9 files reviewed, 1
comments added" and TWO P1 inline comments sat on that exact sha. The conclusion means "the
review ran", never "the review found nothing".

**The AUTHORITY is the summary comment's footer, not the check and not the inline comments.**
Greptile's PR-level comment ends with `Reviews (N) · Last reviewed commit: "<subject>"` and
carries a `Confidence Score: N/5` with a one-line verdict. That footer is the only place that
says WHICH commit it has actually seen. Neither of the two things that look authoritative is:
the check-run conclusion is `success` regardless of findings, and GitHub RE-ANCHORS inline
review comments to the current head (`commit_id` moves, `original_commit_id` keeps the truth),
so stale findings read as if they were just written about your latest push.

```bash
gh pr view <N> --json comments \
  --jq '.comments[]|select(.author.login|test("greptile";"i"))|.body' \
  | sed -E 's/<[^>]+>//g' | grep -iE "^Reviews \(|Confidence Score"
```

**It re-reviews on ORDINARY pushes — a force-push is not needed.** MEASURED across three PRs
on this repo, none of which had a single `head_ref_force_pushed` timeline event: #88 reached
`Reviews (8)` with 8 top-level reviews on 7 different commits, #89 reached `Reviews (2)`, and
both ended with `Last reviewed commit` equal to their final head.

**But it can STALL, and nothing announces that.** MEASURED on #90: `Reviews (1)`, last reviewed
commit still the ORIGINAL head after three ordinary pushes, while CI stayed green and the
re-anchored inline comments looked current. Its verdict was frozen at `Confidence Score: 0/5 —
Unsafe to merge` from before any fix existed. Check the footer after every push; if N has not
gone up, it has not seen your work. The retrigger link in its own comment
(`app.greptile.com/api/retrigger?id=...`) needs a Greptile LOGIN and cannot be driven from the
CLI — it 200s to an auth page. Once the PR is merged, a re-review needs a fresh PR.

So after CI goes green, READ the findings explicitly and work them until it is clean — do not
report a PR as passing on the check alone:

```bash
gh api repos/martinambrus/haive/pulls/<N>/comments \
  --jq '.[] | select(.user.login|test("greptile";"i")) | "\(.path):\(.line) \(.body)"'
```

Severity rides as a `P1`/`P2` badge `<img alt=...>` at the top of each comment body, not as a
field. Resolve each thread once addressed — all 8 of #88's were resolved before it merged, which
is the bar. Greptile takes ~10 min, the slowest check on the PR, so it lands well after the rest.

**CODEX IS THE REVIEWER NOW, AND THE MERGE GATE IS BOTH OF THEM.** The user activated
`chatgpt-codex-connector[bot]` as a PR reviewer on 2026-09-13. Their rule: wait for Codex, then for
Greptile if it still has quota this month, and merge only when NEITHER reports more errors. Greptile
was OFFLINE that day — verified across PRs #91-#94, no `greptile` check run and no comment — so in
practice Codex is the whole gate until its quota returns.

**VALIDATE EVERY CODEX FINDING BEFORE ACTING ON IT.** The user's words: "Codex is not as good of a
reviewer as Greptile". Read the cited lines and the call graph, decide VALID or not, and say which.
On PR #100 all three P1s were valid — but one of them proposed a fix that would have broken a
different caller (moving `llm.prepare` after the dispatch insert breaks `08a-browser-verify`, whose
hook writes the app-login outcome onto `detected` for `buildPrompt` to render). So validate the
DIAGNOSIS and the REMEDY separately: a correct finding can carry a wrong fix.

**React on each comment, thumb up or down, by whether it HELPED.** The user asked for this
explicitly, to give Codex a training signal.

```bash
gh api repos/martinambrus/haive/pulls/<N>/comments \
  --jq '.[] | select(.user.login|test("codex";"i")) | "\(.id) \(.path):\(.line) \(.body)"'
gh api repos/martinambrus/haive/pulls/<N>/comments/<id>/replies -f body='...'
gh api --method POST repos/martinambrus/haive/pulls/comments/<id>/reactions -f content='+1'
```

Severity rides as a `P1`/`P2` badge in the body, same as Greptile. Reply on each thread with the
verdict and what was done, then push the fix and wait for the next review round.

**A PR IS NOT DONE AT ITS FIRST REVIEW — LOOP ROUNDS UNTIL ONE BRINGS NO VALID FIX.** Stated by the
user on 2026-09-14 (PR #103), for EVERY PR: keep looping with Codex (and Greptile while it has quota)
until a round finds nothing to fix, or every finding it raised has been verified and judged false
and the code is stable. Finish on the LAST review, never the first.

**Why:** the user wants a ship to end on a clean review. A fix pushed after round one is new work no
reviewer has seen yet, so stopping there reports as reviewed what never was.

**How to apply:** each round:

1. Wait for Codex to FINISH. Its summary issue comment (`<!-- codex-pull-request-review-summary -->`)
   is edited IN PLACE, so a new comment id is not a finish signal. Key on its own documented contract:
   a 👀 reaction on the PR while any review runs, review comments when it has suggestions, and a 👍 on
   the PR once all reviews finish with no findings.
   Its table row names the commit by a 7-CHAR sha, so an 8-char grep against it never matches.
   That left a watch's status branch dead across several rounds on #102 while only its
   comment-id half worked. Key a watch on the full sha where GitHub gives one (a review's
   `commit_id`) and on the first seven characters for the row. The row can also report the
   review as Failed (MEASURED on #102, commit `1eec4f3`, trigger "New commits"): no review, no
   thumbs-up, and not a clean round. Comment `@codex review`; it then ran and reported normally.
   A submitted review does not end the round either. Codex can post TWO reviews on one commit:
   MEASURED on #102, reviews `5207302136` and `5207320613` on `79ef64c6`, 98 s apart, each with a
   P1, and no `@codex review` comment in between. A watch that exited at the first review plus a
   45 s grace poll never printed the second one's finding, which then sat unreacted through the
   next two rounds until a reaction audit caught it. End a round only once 👀 is gone, and when
   restarting a watch mid-round, diff against the comment ids known BEFORE the push.
   Neither half of the 👀 signal is reliable on its own, in EITHER direction — MEASURED 2026-09-23.
   A review can land with no 👀 ever seen: on #230 round 1 and #236 a 30 s watch never caught one
   (it came and went between polls), yet #230 got a P2 review and #236 a 👍. And a 👀 can OUTLIVE
   the review: on #230 round 4 the summary row read Completed on `3449885` at 18:01:04 and a 👍
   landed at 18:01:08, while the 👀 stayed on the PR 20+ minutes and the watch never settled. So
   the finish signal is the summary row's Completed status on the 7-char sha plus the 👍 (or the
   review/comments on that sha) — and check that row before merging on a "no 👀" verdict.
   A finding can also live ONLY in a review BODY. When the cited line falls outside every diff hunk,
   GitHub cannot anchor an inline comment, so Codex writes the finding into the review body as a
   permalink: MEASURED on #102, review `5208321659` on `a731dbd7` carried one P1 at `global-kb.ts:831`
   and zero inline comments, because 831 sat between the hunks at +555,276 and +833,24. A watch keyed
   on comment ids called that round over with nothing to show. Read every review body on the sha for
   `P1`/`P2` badges. Such a finding has no thread: react on the REVIEW through GraphQL (`addReaction`
   on its `node_id`; `PullRequestReview` implements `Reactable`, and REST has no reactions endpoint for
   reviews), and answer it with a PR comment that names the review id.
2. Read every new comment by id, and validate diagnosis and remedy separately.
3. Reply and react on each finding.
4. Commit and push the valid fixes.
5. Start the next round. Codex's comment lists only three triggers: PR opened, marked ready for
   review, or an `@codex review` comment. It also re-reviews ordinary pushes, though. MEASURED on #103:
   👀 was on the PR seconds after `bd570327` was pushed, and review `5201291723` targeted that sha.
   If no 👀 appears within 4 minutes of the push, Codex is out of allowance: see the rule below.

Stop only when a round ends with the 👍, or with every finding verified false, or when Codex has not
reacted within 4 minutes (next section). For Greptile, its `Reviews (N)` footer must have passed your
last push. Report the final round.

**NO 👀 FROM CODEX WITHIN 4 MINUTES MEANS IT IS OUT OF ALLOWANCE — GO AHEAD WITH THE MERGE.** Stated
by the user on 2026-09-15: Codex is quick to respond, so when no 👀 reaction appears on the PR within 4
minutes of opening it or pushing to it, treat Codex as out of allowance, stop waiting on it, and go
ahead with the PR merge (CI still has to be green, and Greptile keeps its own quota rule above). The
user first said 2 minutes, then widened it to 4 the same day, for leeway in unexpected situations.
REFINED 2026-10-24 (user, [[pr-watch-codex-first]]): before treating that silence as spent,
re-request `@codex review` once; only a retry that stays silent for 4 minutes (or Running past 15)
counts Codex out for that push.

**Why:** the user's reading of how Codex behaves: with allowance it reacts almost at once, so a longer
silence is a spent allowance, not a slow review. MEASURED on #103: 👀 was on the PR by the first
60-second poll after nearly every push.

**How to apply:** a round watcher's "not started" deadline is 4 minutes, and hitting it ends the
review loop for that PR instead of starting another wait. There is also POSITIVE evidence, which
needs no wait at all: when the allowance is spent, `chatgpt-codex-connector[bot]` posts an issue
comment on the PR reading "You have reached your Codex usage limits for code reviews" (MEASURED on
#121 at 2026-09-15T21:53Z and #122 at 2026-09-16T07:14Z, each within a minute of opening). Read the
bot's issue comments first; that text on the PR means merge on green CI without waiting for 👀. History, so the rule is applied knowingly
rather than rediscovered: twice on #103 (`8e16675e`, `877d2c92`) a push got no 👀 for 4+ minutes and an
`@codex review` comment then started a review within about a minute. A missing 👀 is therefore not
proof the allowance is spent; the 4-minute cut-off is the user's call on when to stop waiting.

**The verdict is per PUSH, never carried to the next one.** MEASURED 2026-09-24 on #231: push
`245ee8a4` got no review for 13 h (summary row stuck on the previous sha), so I read Codex as spent,
pushed a main-merge `fc7fc4f9`, watched CI only and merged. Codex had reviewed `fc7fc4f9` at 07:32:49
with a valid P2, three minutes BEFORE my 07:35:59 merge; the fix had to go out as a follow-up PR
(#242). So after EVERY push re-run the full check: the summary row names the 7-char sha as
`Completed` (or `Running`, then wait), or no 👀 and no row for that sha for 4 minutes. A watch that
settles on "no 👀 after 240 s" without reading the row is exactly the watch that merged past a
review; `scratchpad/pr_watch2.sh` of session 3813bbf6 is the row-aware version (settles on
row-completed, usage-limit, row-failed, or silent-240s-with-no-row-for-this-sha). Its run-list check
makes three separate API calls that can disagree: on PR #367 (2026-10-01) it settled on `open=0`
while its own listing still read `CI=in_progress`. The copy in session 539670c6's scratchpad reads the
list once (one `--jq` producing count|open|listing); use that one, and confirm CI's conclusion
directly before reporting a round.

**WHEN EVERY AI REVIEWER IS SPENT, LAND EACH PR ON CI ALONE AND THE USER REVIEWS THE BATCH
THEMSELVES.** NOT IN FORCE: lifted 2026-10-18 ("Codex is up and reviewing, let's reactivate that
check"), so the full Codex loop above is the gate again. While in force, the rule was: no `@codex review`, no waiting on a
Codex row, merge on green CI checks (Actions CI, CodeQL, GitGuardian), CLEAN merge state and 0
unresolved threads. Pauses: 2026-10-16 ~21:45Z to 2026-10-18 ("we ran out of Codex allowance -
exclude Codex checks until I tell you (only check CI)"); earlier, 2026-10-14 to 2026-10-15 ("Codex ran out of
allowance, let's ignore it until I tell you otherwise", lifted with "Codex is
back, so please use it for reviews"); PRs #718, #729-#744 and #746 merged on green CI alone in that window. Stated by the user on 2026-09-16, with Codex out of review quota and Greptile's month
also gone: "we'll only keep checking CI to pass and I'll review the code independently myself later
as a whole." So for the rest of such a stretch, do NOT open a review round, do NOT post
`@codex review`, and do NOT spend the 4-minute wait on each push — verify locally (typecheck,
tests, prettier), push, wait for CI, and merge on green. Codex's review quota is WEEKLY, not
monthly like Greptile's: on 2026-09-16 the user said it returns "next Sunday" (2026-09-20), so the
loop comes back within days rather than at the month's end — say which mode a PR landed in, since
a batch merged this way has had no bot review at all and the user's own pass is the only review it
will get.

**WATCH FOR NEW FINDINGS BY COMMENT ID, NEVER BY A TIMESTAMP.** Stated by the user on 2026-09-14
after they spotted Codex comments carrying no reaction from me and said they could not tell whether
those were new or already handled. MEASURED the same day on PR #102: two poll loops of mine filtered
`select(.created_at > "...")` with cutoffs of `10:15Z` and `10:40Z` while the real clock was
`10:10Z` — both predicates were in the FUTURE, matched nothing, and I reported rounds 3 and 4 as
CLEAN. Five findings were sitting unacknowledged, three of them live defects, and a merge
recommendation had been built on the false all-clear.

**Why:** a timestamp predicate fails SILENTLY and in the safe-looking direction — zero rows reads
exactly like zero findings. The same class as the short-sha and unfiltered-list traps in
[[gh-run-watch-exit-status-lies]]: the query was broken, not the subject. An id set cannot drift
against a clock, needs no timezone reasoning, and a new id is positive evidence rather than the
absence of a match.

**How to apply:** snapshot the ids before the push, then diff each poll against that set and fetch
any id that is new:

```bash
KNOWN=$(gh api --paginate "repos/martinambrus/haive/pulls/<N>/comments?per_page=100" --jq '.[].id' | tr '\n' ' ')
# each tick: for id in $(gh api --paginate ... --jq '.[].id'); do case " $KNOWN " in *" $id "*) ;; *) echo NEW $id;; esac; done
```

**PAGINATE, OR THE NEWEST IDS NEVER ARRIVE.** GitHub lists review comments, issue comments and
reviews OLDEST first, 30 per page by default. An unpaginated poll therefore stops showing new ids once
a PR passes one page, and reads as a quiet round: the same silent-zero failure as the timestamp
filter. MEASURED on #103 on 2026-09-15, after 21 review rounds: 62 review comments and 51 reviews,
both past the default page. Use `gh api --paginate` on every list the watch reads. With `--paginate`,
never feed a `length` into an integer test, since it prints one number PER PAGE; select the ids and
count lines instead (`--jq '.[] | select(...) | .id' | grep -c .`).

The reaction state is also the ledger the USER reads — an unreacted comment is one they cannot tell
you have seen. So audit it directly rather than trusting the watch, and treat any zero as a query to
disprove:

```bash
gh api --paginate "repos/martinambrus/haive/pulls/<N>/comments?per_page=100" \
  --jq '.[]|"\(.id) | \(.created_at) | 👍=\(.reactions["+1"]) | \(.path)"'
```

**"Codex found nothing" read FALSE twice on PR #202, both times from HOW I read it, not from what it
found. A clean per-sha review is not a clean loop.** Encode all three of these, or a live finding sits
unaddressed for a round:

1. **Never truncate the findings listing.** Piping it through `head -70` cut the SECOND finding of a
   two-finding round; I reported one, fixed it, and the other was found later by a thread audit. Print a
   COUNT first, then every body whole.
2. **The REST list endpoint LAGS.** MEASURED: a finding created at 13:47:20Z was still absent from
   `pulls/<n>/comments` at 13:47:49Z and the count read 0, while GraphQL `reviewThreads` already showed
   it. So wait a grace period after "Completed" AND cross-check GraphQL; a GQL line missing from REST is
   replication lag, not a clean round.
3. **A per-sha filter cannot see an OLDER finding that is still open.** Before declaring any loop clean,
   audit review threads by RESOLUTION state and check each still-anchored one against the current tree:

```bash
gh api graphql -f query='{repository(owner:"martinambrus",name:"haive"){pullRequest(number:<N>){
  reviewThreads(first:100){totalCount nodes{isOutdated comments(first:1){nodes{
    path originalCommit{oid} body}}}}}}}'   --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isOutdated==false)
        |"\(.comments.nodes[0].originalCommit.oid[0:7]) \(.comments.nodes[0].path)"'
```

`isOutdated: true` means the anchor no longer maps, which is consistent with having been fixed;
`isOutdated: false` is the set to verify by hand. Codex resolves NONE of its own threads, so a merged PR
legitimately carries them all open — unresolved is not unaddressed, and the audit is how you tell.

**REMOVE YOUR OWN WORKTREE AS SOON AS ITS PR MERGES — AND ONLY YOUR OWN.** Stated by the user on
2026-09-25: worktrees pile up and the host drive fills until WSL hits 0 bytes and freezes the machine.
Other sessions' worktrees (the peer sweep keeps branches staged ahead of their PRs) are theirs: never
remove or message about them. Before `git worktree remove`, confirm the PR is MERGED and the worktree
is clean with no live process cwd inside it. Deleting inside WSL does not shrink the host vhdx, so this
slows growth rather than returning space; see [[wsl-host-disk-layout]].

Still not specified, so do not invent a convention — ask if it matters: branch naming, and whether
they want the PR opened as a draft. See [[haive-ship-cycle]] for how the steps are offered as one
question.

**Keep looping Codex until a round comes back clean, even when rounds narrow.** Asked on 2026-10-12
whether PR #593 (5 rounds, each a narrower but real edge in the banner's 202 polling) should merge on
green CI with later findings filed as follow-ups, the user chose "Keep looping". So a narrowing
series is not by itself a reason to stop: fix each valid finding and re-request until clean. Asking
is still right when a finding needs a design decision the user owns (as #575's residual window did).
