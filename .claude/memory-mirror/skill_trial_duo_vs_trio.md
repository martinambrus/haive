---
name: skill-trial-duo-vs-trio
description: "Running A/B trial of /opus-sonnet (duo) vs /opus-sonnet-haiku (trio): record every task in .claude/tmp/skill-trial/trials.jsonl and decide by the README's rule"
metadata:
  node_type: memory
  type: project
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-17T14:37:15.777Z
---

Since 2026-10-16 the user wants the two driver skills compared on measured data: if the trio (Opus maps/judges,
Sonnet plans, Haiku implements and verifies) passes a few trials and beats the duo on cost and speed, use it while it
is monitored until the difference is statistically meaningful, then keep only the winner (ditch the duo, or the trio
if the data say so). Both arms are measured until then.

Protocol, decision rule and tooling: `/home/activit/haive/.claude/tmp/skill-trial/README.md` (untracked); one JSON
line per accepted task in `trials.jsonl` there; `analyze.py` + `report.py` compute price-weighted cost from the agent
transcripts. Assignment alternates per weight class; >= 8 tasks per arm per class before deciding; bootstrap 90%
interval of the trio/duo cost ratio; quality (fix rounds, valid review findings, CI reds) must not get worse.
Fetch current per-model prices at decision time.

PHASE RULE (user, 2026-10-16): once the duo baseline has enough samples, run every NEW task under the trio only (no
more duo spending), and decide when the trio has its own samples. The duo baseline came from this session's 278 Sonnet
build/fix/harness transcripts (duo-baseline.json), so new tasks have been trio-only since 2026-10-16 ~16:00Z.

**Why:** the user is saving tokens and cost; the old-skill profile ([[opus-sonnet-cost-profile]]) showed checks, not
edits, dominate builder spend, which is what the trio moves to Haiku.

**How to apply:** every session that runs either skill appends a trials.jsonl line per accepted task (agent usage from
each completion notification, started/accepted times, fix rounds, valid review findings); report at each 4-task
milestone; task "TRIAL: duo vs trio" in the session task list mirrors this. Related: [[haive-opus-sonnet-workflow]].

**Milestone 1 (2026-10-16, 7 trio fixes):** trio Sonnet units median 3.83M vs duo Fix median 2.52M, every trio task
above the duo median before any Haiku cost; wall ~59 vs 26 min. Early stop not met (duo p75 4.16M). Table in
.claude/tmp/skill-trial/README.md "Milestone 1". Decide at 8 per class with live prices.

**Decision point, Fix class (2026-10-16 evening):** 8 trio vs 109 duo fixes at live prices: trio median $5.81 vs duo
$3.53; cost ratio 1.65 (90% CI 1.41-1.94), time ratio 2.06 (CI 1.45-2.61); Haiku 5% of trio cost. The trio LOSES on
fixes by the README rule. Per the user's own rule (#7: "or ditch trio and keep using duo, if your analysis prove it's
more efficient") new work goes back to the duo; reported to the user, who decides about deleting the trio skill.

**Trial 2 (user 2026-10-16 evening):** trio REMOVED (commands, exports, Downloads copy). New arms: Opus-Haiku and
Sonnet-Haiku (skills ~/.claude/commands/opus-haiku.md, sonnet-haiku.md), each task under its own `Drive: <task>`
agent (opus / sonnet) with Haiku builders. USER RULES: no new Opus-Sonnet duo work until analysed; at 8 Fix tasks per
new arm STOP and show the user the results before deciding. Protocol: .claude/tmp/skill-trial/README.md "Trial 2".

- 2026-10-16 late evening, user: track found-not-fixed YIELD per trial-2 task (reported / valid / consequential / own regressions caught, plus valid Codex escapes); FNF discovery outranks small cost or speed gains in the decision. Scripts: .claude/tmp/skill-trial/trial2.py, fnf_count.py.

**Trial 2 (OH = Opus driver + Haiku builders, SH = Sonnet driver + Haiku builders; 8 Fix tasks each, done
2026-10-17, table in the README "Trial 2 result"):** median $8.17 / 34.6 min (OH) vs $5.66 / 44.9 min (SH); OH/SH
cost 1.44 [0.88, 2.03], time 0.77 [0.49, 1.39], neither conclusive. OH is above even the duo's upper bound ($7.20);
SH sits inside the duo bracket [$3.53, $7.20]. Quality: OH 0 fix rounds / 0 takeovers / 0 escapes in 5 reviewed PRs;
SH 2 / 1 / 1 escape. Consequential found-not-fixed items 12 vs 12. Drivers are 91-94% of cost, so the builder model
barely moves it. Results shown to the user 2026-10-17; the next step is the user's decision. Do not launch more trial
or Opus-Sonnet work before it.

**Trial 3 (OHL = lean Opus-Haiku pair, driver Opus@high + Haiku@medium builders, spec briefs, ONE spot check;
skill ~/.claude/commands/opus-haiku-lean.md; done 2026-10-17, README "Trial 3 RESULT"):** median $2.14 / 12.4 min,
0.26x OH v1 (CI [0.20, 0.43]); 2 fix rounds + takeovers, 1 CI red; but only 6 consequential found-not-fixed vs >= 10
required (OH v1: 12) -> NOT adopted by the pre-registered rule. Matches the user's concern that lower effort/leaner
reading finds fewer related-code issues. Arms ran different tasks, so the paired replay matrix
(.claude/tmp/replay/ledger.md) is the clean effort test. Lean-protocol failure modes seen: Haiku builders report
"done" while background runs continue; drivers stall when a builder's completion reaches main instead (main must relay).

**Replay matrix (done 2026-10-17; 6 merged Fix tasks x 7 variants in history-free copies, blind FNF grading; result
block in the README, numbers from .claude/tmp/replay/analysis.py):** correctness TIE (3 of 4 oracles pinned the
merged fix's names/shape/design, so read every oracle failure before scoring). Consequential FNF recall, Opus-medium
driver vs Opus-max driver (both with Opus-medium builders): 0.546 of max (rule needs >= 0.8) -> FAIL, the driver /
reading role STAYS AT MAX. Minor valid clusters 0.56x; max costs 2.67x and takes 2.19x the time. Caveat: only 4
consequential clusters in the blind reading; the Haiku-builder pair (ohh/ohm) matched omx on them at under 1/3 the
cost. The user's strict-audit decision (#218) would also count r163's by-design best-effort-audit cluster -> 0.353.
Named next tests: read-only Opus max scan + medium driver/builder; the user's Sonnet variants. Replay process lessons:
fnf.md = the run's FNF section verbatim (orig = its OPEN PRE-EXISTING items); briefs must forbid heredoc/inline-script
edits (one waited 4 h on a permission prompt overnight); time = cost.py's minutes (gaps > 15 min dropped).

**Replay matrix 2 (done 2026-10-17; same 6 tasks x 7 new variants, union pool, README "Replay matrix 2 RESULT"):**
Sonnet max driver + Sonnet medium builders (ssx pair) PASSES the pre-registered rule: 0.889 of the Opus-max driver's
consequential recall, trails on 1 of 6, at 0.62x cost and 0.98x time, 1.26x minor clusters, same correctness (one
Retry-race edge each). Opus-max read-only scan + Opus-medium driver/builders (xom pair) FAILS on cost (1.29x; the
scan is 71% of it) although recall is 1.67x and it alone found all 3 new consequential bugs (#226 #227 #228); twice
its medium driver adopted a wrong scan design call and shipped a behaviour gap (r163 item 3 skipped, r167 item 4
half-done). Sensitivity reading (r163 best-effort audit counted): Sonnet 0.471 -> would fail; nobody in matrix 2
reported that cluster. shh (Sonnet high + Haiku max) is the cheapest arm with 3 consequential clusters ($16.70 / 6
tasks), but 460/612 Haiku requests crossed the 100k tier (4.2x its Haiku cost). Lessons: replay agents see the main
checkout's recent commit subjects (a hint toward recent work); leftover wait timers re-notify, so recompute costs at
batch end; a "Dropped:" line can be a heading over bullets. The workflow decision is the user's.

**Pair skills (created 2026-10-17 on the user's request):** `/opus-opus` (ranked #1 for FNF filled + fixed) and
`/sonnet-sonnet` (#2) in ~/.claude/commands/, generated from the duo skill (opus-sonnet.md) by
scratchpad make_pair_skills.py: same protocol; driver + analysts at max, harness/builders/fixers/testers at medium,
`model` and `effort` on every Agent call; a session on another model launches one `Drive: <task>` agent at max (the
sonnet-haiku pattern). Fallback amended the same day on the user's word: the driver agent files nothing and returns
verified FNF items with a proposed bundle; the session reads each task's diff and touched code for its own FNF items
(read-only; a defect goes back as a fix round), files everything by bundle, then pushes. Meant for an Opus max
session running `/sonnet-sonnet` per task (Opus catches what Sonnet drivers miss, e.g. best-effort audit rows);
unmeasured, pilot it against the matrix numbers. Exported as zips (`<name>/SKILL.md`, opus-sonnet.zip's format) to
/mnt/c/Users/Activit/Downloads/. Caveat: the ranked replay arms ran the lean single-builder protocol, so the duo
protocol's analysts and harness agents add cost the matrix did not measure.

**Old commands retired (2026-10-17, user: keep them out of the way of `/sonnet`):** opus-sonnet, opus-haiku,
sonnet-haiku and opus-haiku-lean moved from ~/.claude/commands/ to `~/.claude/skill-archive/<name>.2026-10-17.md`
(sha256 unchanged); only /opus-opus and /sonnet-sonnet remain. make_pair_skills.py and replay make-brief.py read
the archived copies. The claude.ai upload `opus-drives-sonnet-builds` (the old duo; both sync buckets under
~/.claude/skills/synced/ list it) stays until the user deletes it on claude.ai; the local synced copy was not touched.

**Pilots of the chosen workflow** (one row per task in the README's "Pilots" table; cost script
scratchpad `pilot_cost.py <out> <start ISO> now <driver id> [<fixer id>...]`, which also prices the main session's
own requests in the window): pilot 1 = #226 (#834), $8.99 = agents $2.95 + Opus session $6.05. The session's
~326k context, not the agents, set the price, so compact first. Pilot 2 = peer session 3813bbf6's #307 (#835, Full
design task, run in parallel): $25.43 = agents $22.09 (2 analysts at max $11.71, 53%) + session $3.33 (16 requests at
~914k context). Its driver verified 8 items (2 consequential). After both pilots the Opus diff review had added 0
items. A peer's self-reported launch time was 53 min off, so take windows from the driver transcript's timestamps.

M3 Codex matrix (2026-10-18, ledger .claude/tmp/replay/ledger.md): Codex (gpt-6.1-sol) drives alone + Sonnet xhigh read-only review, 6 tasks. cx (max), cx2 (max repeat) and cxHi (high) all IDENTICAL on the oracle; consequential 5/5/6 (omx 3); minor 23/21/21; Claude $ 7.84/8.53/7.77 = ~0.23x ssx. High uses ~30% fewer Codex tokens and ~40% less wall. Codex trait seen 3/3: keeps a best-effort audit helper and leans on Postgres aborted-savepoint semantics (r167). Gotcha: codex exec -C <tree> needs an ABSOLUTE brief path (relative -> max searched /home/activit, high gave up).
SKILL CREATED 2026-10-18: ~/.claude/commands/codex-sonnet.md (exported /mnt/c/Users/Activit/Downloads/codex-sonnet.zip): session orchestrates, `codex exec` HIGH drives each task alone in its worktree (background Bash, absolute brief path, < /dev/null), fresh Sonnet xhigh read-only review, fix rounds as new Codex runs, FNF by bundle. Not yet piloted on a live task.

PILOT 1 of /codex-sonnet, 2026-10-18, task #229 FNF[diff-status-exit] -> MERGED #836 (0d2770ed8). Codex high: round 1 251 s, 2.06M in (1.96M cached) / 13.6k out; fix round 140 s, 1.30M in (1.22M cached) / 8.1k out. Sonnet xhigh review 161k tokens, 220 s; it caught a real gap (a failed status left an earlier artifact, so gates 11/01e would show a stale diff), which Codex had listed only as PRE-EXISTING. Session had to undo Codex's over-deletion of still-true comments in the fix round (a fix brief that says "correct these comment lines" gets whole comment blocks rewritten; say "change only these lines, keep the rest verbatim"). PR Codex review: 1 valid P2 on the session's own doc paragraph. Ledger .claude/tmp/codex-sonnet/ledger.md.

PILOT (peer) of /codex-sonnet, #280 FNF[merge-resolver] -> MERGED #837 (1a82a3bf3): Codex high 8 runs (drive + 7 fix rounds: 3 from Sonnet reviews, 4 from PR Codex review), 57.4M in (56.2M cached) / 263k out; Sonnet xhigh 4 reviews 217-296k each. A larger concurrency task costs ~25x #229's Codex tokens. Codex put TMPDIR inside the repo (fake "pre-existing" failures; baseline was a file diff, not a test run) -> skill now forbids it and demands a test-run baseline. Each review found real defects, incl. regressions from the prior fix round.

PILOT 2 of /codex-sonnet, 2026-10-18 (this session 3813bbf6), task #280 FNF[merge-resolver] (fetch outside tx, squash proof, halt claims, pinned pushes) -> MERGED #837 (1a82a3bf3), main CI watched. 8 Codex high runs = drive + 7 fix rounds: rounds 1-3 from Sonnet xhigh reviews, 4-7 from Codex PR review (4 PR rounds with findings, then a 👍). Codex total 57.4M in (56.2M cached) / 263k out, ~126 min wall; 4 Sonnet reviews 217-296k tokens each. Every Sonnet review found 1-2 REAL defects, two of them regressions from the previous fix round; the PR review then found 4 more in narrow crash/concurrency windows. Big squash/claim state machines take many rounds: prefer a structural invariant (ancestry, recorded sha) over per-case patches. Lessons for briefs: (1) forbid setting TMPDIR or other env vars inside the repo. Codex ran the suite with TMPDIR in the main checkout, broke build-stamp's "outside a checkout" fixtures, and called them PRE-EXISTING from a file diff, not a run; always re-run a "pre-existing" failure yourself in a clean env. (2) Codex once disabled the husky hook to commit; say "keep husky on". (3) Verify red-on-base yourself by checking out the round's base src files with the new tests (Codex's red timestamps cannot prove the src was unchanged). Ledger .claude/tmp/p280/ledger.md.

PILOT 3 (peer fix-modular-forms-save-path, private Drupal repo), FilePond spike, 2026-10-20, not merged (awaiting user): 11 Codex tasks, 38 runs, 375.7M in (98.6% cached) / 1.78M out, 16.5 h; 25 Sonnet xhigh reviews ~8.85M+. Every review round found real defects; two bugs only the session's real-browser pass found (decimal size option truncated client-side; late web font stale layout). Lessons folded into the skill 2026-10-20: report/cleanup first in the brief, harness fixtures carved out of prohibitions, runtime trace before deleting "dead" code, browser check with non-default inputs. Ledger .claude/tmp/codex-sonnet/ledger.md.
