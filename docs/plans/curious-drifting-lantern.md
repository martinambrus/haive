# Follow-ups from the agent-memory / spec-handoff verification run

## Context

Findings collected while verifying `replicated-zooming-beacon.md` (commits `c06cefe`,
`5bfb676`, `fc7e47d`, `8afc597`, `fddc8b4`, `b35967a`) against a live workflow task.

Verification task: `153a3437-be3c-409b-926e-b0c14fa71354` — "Add structured error
logging" on `rs_opus_4_6_low`, claude-code Opus 4.6 Low (subscription), execution path
`plan_tasklist`, single mode, one fix round, completed through gate 3.

What the run PROVED (no action needed):

- Slice 1: `.haive/spec.md` absent before gate-1 approval, written on the approve branch,
  sha256 byte-identical to the approved spec, and NOT tracked by git (verified with
  `git ls-files --error-unmatch`) so it never enters a feature commit.
- Slice 2: the six keep-full steps (04, 04a, 05, 05a, 06-run-config, 06b) all received the
  FULL spec; 07 and all three 08c reviewers received the index plus a working pointer.
  MEASURED on a 23,491-char approved spec: index+pointer 13,557 chars, saving 9,934 chars
  = 25.5% of the whole step-07 prompt, 42% of the spec portion, all 23 headings preserved.
- Slice 3: explicit ledger writes from 07 (change/finding/finding, matching its output
  fields exactly), 07b, and 08; `loadPriorFixContext` sourced from the ledger at round 1.
- Slice 4: the step-summary mirror crossed the queue boundary into the next step's prompt.
- `fddc8b4`: all three 08c mining agents carried the ledger (they would read `no` without it).
- `b35967a`: at round 1 the prompt carries both `loadPriorFixContext` and the ledger block,
  and a shared fact appears exactly ONCE — the dedupe guard held.

Fix these before the DAG verification run.

---

## F1 — The summary mirror only covers steps with no curated summary

**Severity: medium. FIXED — commit `6e72b08`.** Live proof pending: 03/04/06b should
appear as `summary` ledger entries on the next run.

`step-runner.ts` gates the summarizer on `!curatedSummary`, and `resolveCuratedSummary`
returns the first non-empty of `findingsSummary` > `summary` > `notes`. So a step that
emits any of those keys never runs the summarizer, and slice 4 has nothing to mirror.

MEASURED on the run: `03-phase-0a-discovery` and `04-phase-0b-pre-planning` are absent
from the ledger entirely. `07`, `07b` and `08a` are present only through slice 3's
explicit writes, never as summaries.

Second-order consequence: the "prefer a step's summary over the raw entries it covers"
branch in `augmentPromptWithLedger` is UNREACHABLE. The two mechanisms partition
perfectly — a step either has a curated summary (explicit writes, no mirror) or does not
(mirror, no explicit writes) — so no step ever has both kinds on one `taskStepId`.
Verified with a live query: zero rows. Only `dropped oldest` ever logged (12 dropped,
8 kept), never `preferred step summaries`.

The unit test for that branch passes because its fixture hand-builds a state production
cannot produce. Green test, dead code.

**Fix:**

- Where `resolveCuratedSummary` returns non-null, mirror THAT text into the ledger at
  finalize with `kind: 'summary'`. No new LLM call — the text is already in hand.
  Do NOT drop the `!curatedSummary` gate on the summarizer itself; that would add a real
  invocation per curated step and falsify slice 4's no-extra-cost property.
- Scope the preference branch: a summary may supersede only entries of `kind: 'change'`,
  never `kind: 'finding'`. RATIONALE: for 07 the summary condenses the CHANGE, while the
  findings hold environment facts. Unscoped, the branch would evict exactly the content
  the ledger exists to carry.
- Rebuild the unit test around a fixture the production path can actually emit (a step
  with a curated summary plus explicit change/finding writes).

**Verify:** on the next run, confirm 03/04/07/07b appear as `summary` entries; confirm a
`preferred step summaries` log line appears once the ledger exceeds budget; confirm no
`finding` entry is ever superseded by a summary.

---

## F2 — `08-phase-5-verify` runs its `apply()` twice

**Severity: medium. NARROWED — commit `d73bb55`.** The duplicate delivery is now
harmless (a finalized row is not re-run). It is still ENQUEUED; who enqueues it is
unresolved — see the open question at the end of this section.

MEASURED: two `ledger.entry` rows for `08-phase-5-verify`, 0.6s apart
(`19:27:44.966` and `19:27:45.591`), identical text, identical fingerprint, SAME
`task_step_id` (`68aa9e72-...`), and the step row's `ended_at` is `19:27:45.594`.

The ledger is unharmed — `loadLedgerEntries` dedupes by fingerprint and the injected
block carried the fact exactly once (verified by counting occurrences in the 08c prompt).
But a double `apply()` means the step RAN ITS VERIFY COMMANDS TWICE. On this repo all
three runners were absent so it cost nothing; on a repo with a real test suite it is a
duplicated test run per verify step.

Deterministic ledger writes are what made this observable — nothing else about the step
is idempotency-sensitive, so it had no visible symptom before.

**Root cause (found):** the same-step duplicate guard in `handleAdvanceStep` only fires
for a row still `running`. The second job arrived AFTER the first finished, so
`existing.status === 'done'` matched neither it nor the `skipped` guard, and the step
re-executed. It also slipped the other-active guard, which read `otherActive` in the same
instant the successor's row was being created.

**Done:** a finalized row returns instead of re-running, re-driving the hand-off only when
`tasks.current_step_id` still points at this step and round.

**SOURCE FOUND:** a parked step re-drives itself with a DELAYED advance for the same
(step, round, epoch) — `enqueueAdvance(..., { delayMs: PAUSE_POLL_MS })` in the pause park
and `RUNTIME_PARK_POLL_MS` in the runtime-slot park. Nothing deduplicated those, so a step
that parked twice (a pause tick plus the hand-off, or two pause ticks) had two live jobs,
and when the hold lifted both fired. That matches the observed 0.63s gap.

**STILL OPEN — and a fix was ATTEMPTED AND REVERTED (`3ac59bd`, reverted). Do not retry it
the same way.**

The attempt gave park ticks a deterministic BullMQ `jobId` so a repeat would collapse onto
the pending one. It failed twice on a live task:

1. `Custom Id cannot contain :` — BullMQ rejects a colon in a custom id (its Redis key
   separator). The failure surfaced at TASK level with no failed step, because it throws
   inside handleAdvanceStep's park enqueue, outside any step write. Easy to fix, and not
   the real problem.
2. **The approach itself is wrong.** A park tick re-arms itself FROM INSIDE ITS OWN
   EXECUTION, so its own jobId is still held by the running job and BullMQ silently drops
   the re-add. The park stops re-arming, and the step keeps its last status copy forever —
   observed as "waiting: runtime slot, stalled?" with a stale "global pause is on" message
   while the pause banner said otherwise. Confirmed by `ZCARD bull:task-queue:delayed` = 0:
   no tick armed anywhere.

`removeOnComplete: true` does NOT save this: removal happens after the handler returns, and
the re-arm happens during it. A unit test asserting that option passed while the runtime
behaviour was broken — it encoded the belief, not the sequence.

**A self-re-arming poll cannot deduplicate on its own id.** That rules out the whole
approach, not just the separator.

**Reassessed priority: LOW.** The `d73bb55` guard already makes a duplicate harmless, so
the remaining cost is one wasted job. Every attempt to suppress it so far has risked
stalling the orchestrator, which is far worse than the wart.

**If revisited:** use a PRE-ADD CHECK (query the queue's delayed/waiting jobs for that
step and skip the add) rather than a `jobId`. It has its own race, but it fails toward an
extra duplicate — which is already handled — instead of toward a wedge. Verify against a
REAL park cycle (pause, let a tick fire, unpause), not a synthetic queue probe: the probe
used for the jobId attempt collapsed two adds correctly and told us nothing about the
self-re-arm case that actually broke.

**Verify:** one `ledger.entry` per `(task_step_id, fingerprint)` on a clean run, and a
`advance-step skipped: step already done` warn line where the duplicate used to re-run.

---

## F3 — `08a` and `08d` ledger writes were never exercised

**Severity: low (coverage gap, not a defect).**

The `plan_tasklist` execution path does not materialize `07a`, `08a`, `08d`, `08d2` or
`08e` at all — zero rows in `task_steps`. So the explicit `recordLedgerEntry` calls added
to `08a-browser-verify` (tester notes, fixer notes) and the reasoning that `08d` is
covered by the summary mirror are UNIT-TESTED ONLY.

The `08c` half of that reasoning IS confirmed: it reached the ledger via the mirror
(`08c-code-review / summary / 1059 chars`), which is what justified not adding a dead
`environmentFindings` field to six fan-out reviewer prompts.

**Fix:** none needed to the code. Run one task on the `full_workflow` path (not
`plan_tasklist`) so those steps materialize, and confirm the writes land.

---

## F4 — `ledger.entry` stores `kind` as null for findings

**Severity: cosmetic. FIXED — commit `6e72b08`.**

`recordLedgerEntry` writes `kind` only when the caller passes it, and callers pass it
only for `change`/`summary`. `loadLedgerEntries` coerces null to `finding` at read time,
so behaviour is correct — but the stored rows are awkward to query and any future
consumer must repeat the coercion.

**Fix:** default `kind` to `'finding'` at WRITE time so the column is always populated.
Read-side coercion stays as the compatibility path for rows already written.

---

## F6 — Gate 4 makes `remoteUrl` required on a path its own `apply()` supports

**Severity: medium. FIXED — commit `d5162d5`.** Unit-proven against the real gate-4
schema. NOT yet proven end-to-end: retrying gate 4 on the completed task hit the
no-git branch (step 12 had removed the worktree), which the change does not touch.
The DAG run will reach it with a live worktree and no origin.

`11a-gate-4-push` `form()` builds a no-origin branch whose `remoteUrl` field is
`required: true` with NO `visibleWhen` gate, alongside a `push` checkbox defaulting to
false. But `apply()` opens with:

    if (!values.push) {
      return { pushed: false, remote: null, branch: detected.branch, message: 'push skipped' };
    }

So `push: false` is an explicitly supported input that the form's own validation refuses
to produce. Submitting `{"push": false}` on a repo with no origin fails with
`validation failed: remoteUrl: required`, and the step — plus the task — goes to `failed`.

MEASURED on task `153a3437` (repo `rs_opus_4_6_low`, `repositories.remote_url` is null).
Every earlier workflow task SKIPPED this step, so the path had never been exercised;
this is the first task to park on it.

The intended escape hatch is the Skip button (`allowSkip: true`, with a comment reading
"Local-only projects have no remote to push to; allow the user to Skip this gate so the
task can still finish"). Skip does recover it. But an unchecked `push` box that fails
validation is a trap: the form offers a control whose only outcome is a failed task.

**Fix (pick one):**

- Gate the field: `visibleWhen: { field: 'push', equals: true }` and drop `required`, so
  declining the push submits cleanly and reaches the `!values.push` branch; or
- Drop the `push` checkbox from the no-origin branch entirely, making Skip the only way
  out and matching what the metadata comment already says.

The first is better — it makes the form agree with `apply()` rather than removing a
control the apply path handles.

**Verify:** on a repo with no origin, submitting with the push box unchecked completes
the step with `message: 'push skipped'` instead of failing.

---

## F7 — 08a reports `passed: true` when browser testing was impossible

**Severity: HIGH. FIXED — commit `1243213`.** Live proof pending: needs an 08a mcp run
that captures nothing (i.e. F8 still unresolved) to show NO EVIDENCE at gate 2.

MEASURED on task `de2b313d` (repo `rs_glm_53_max`, `browserMode: mcp`):

    method=mcp  passed=true  ran=true  screenshots=0

and the tester's own notes say:

    "Chrome DevTools MCP server never connected during this session — no
     browser-based testing was possible. curl and WebFetch also cannot reach the
     DDEV container from this sandbox (ECONNREFUSED). All testing was performed via
     static code analysis of the changed files. ... LIMITATION: No runtime/browser
     testing was performed — AC-1 through AC-15 are verified at code structure level
     only, not end-to-end."

So the BROWSER-verification step passed without a browser, on static reading alone,
and gate 2 downstream sees a green browser check. That is worse than failing: it
manufactures evidence of a verification that did not happen. Login-gated surfaces
(admin forms, the audit-log viewer, the upload UI) were never exercised at all.

`parseBrowserTestOutput` takes the agent's `passed` at face value. The agent is being
honest in `notes` — the step just does not read it.

**Fix direction (decide before implementing):**

- The step knows its own mode. When `method === 'mcp'` and the run produced NO evidence
  of browser use (zero screenshots AND no console/network probe results), `passed: true`
  is not a credible outcome. Treat it as a failed/incomplete verification rather than a
  pass — mirroring `reviewIncomplete` in 08c, which already distinguishes "the reviewer
  failed" from "the code is wrong" so it does not burn a fix round.
- Do NOT key on the notes text — that is model prose and will drift. Key on the
  structural evidence: screenshots emitted, probe results present, or an explicit
  MCP-availability signal captured at dispatch.
- Prefer surfacing at gate 2 (like `reviewIncomplete` / `advisoryVerdict`, which hold the
  gate off its approve default) over routing a fix round: the code may be fine; what
  failed is the verification.

**Related, separate:** why the MCP did not connect at all. See F8.

---

## F8 — chrome-devtools MCP never connected in 08a mcp mode

**Severity: medium. ROOT CAUSE FOUND, not yet fixed.**

**The agent's MCP discovery window (~50s) is less than half chrome-devtools-mcp's cold
npx download (MEASURED 111s).** The server was still fetching from npm when the agent
concluded it did not exist and fell back to static analysis.

Everything that should have made it work checks out, verified live while the runner was
still up:

- CDP endpoint live on the runner: `Chrome/151.0.7922.137` on `:9223`.
- Reachable from the sandbox network: a throwaway container on `haive-sandbox` got a
  200 from `http://172.21.0.6:9223/json/version`.
- The prompt DID advertise chrome-devtools.
- No race: Chrome started 22:52:00, the invocation dispatched 22:56:22.
- Provider egress is `mode: full`.
- All three launch flags exist on `chrome-devtools-mcp@latest`
  (`--allowUnrestrictedPaths`, `--browserUrl`, `--executablePath`); Haive passes the
  kebab-case spelling, which yargs' default camel-case expansion should alias.

What could not be recovered: the transcript. `cli_invocations.raw_output` holds only the
final JSON, and the Redis `cli-stream:<id>` had already been trimmed (`XLEN 0`).

CONTEXT THAT MATTERS: this was the FIRST EVER `mcp`-mode 08a run in this install. The
only two prior 08a runs (June) were `interactive`. So the path has no history of
working — this is an untested path surfacing, not a regression.

Separately and NOT a bug: `curl`/`WebFetch` cannot reach `https://<project>.ddev.site`
from the sandbox — MEASURED, returns 000. `.ddev.site` resolves to 127.0.0.1, which
inside the sandbox is the sandbox. Agents are meant to reach the app through the
CDP-wired MCP, not by URL. Do not "fix" this by exposing the app URL to the sandbox.

### Evidence

The transcript IS recoverable — it lives in `cli_invocations.stream_log` (a DB column with
a multi-day retention sweep), NOT only in the Redis `cli-stream:<id>` key, which trims
within hours. 126 KB recovered for invocation `e7ca1e24-...`:

    "mcp_servers":[{"name":"chrome-devtools","status":"pending"},
                   {"name":"filesystem","status":"pending"},
                   {"name":"git","status":"pending"},
                   {"name":"haive-rag","status":"pending"},
                   {"name":"ddev-control","status":"pending"}]

    22:56:22  invocation starts
    22:57:12  ToolSearch "chrome-devtools"       -> matches: [], total_deferred_tools: 23
    22:57:16  ToolSearch "+chrome screenshot..." -> matches: [], total_deferred_tools: 23
              agent: "Chrome DevTools MCP tools haven't loaded yet" -> falls back

MCP itself was NOT broken: `mcp__ddev-control__ddev_status` was invoked successfully in the
same run. The difference is purely how each server starts:

| server          | launch                                  | result            |
|-----------------|-----------------------------------------|-------------------|
| ddev-control    | bind-mounted .mjs via `node`            | connected, used   |
| haive-rag       | bind-mounted .mjs via `node`            | available         |
| chrome-devtools | `npx -y chrome-devtools-mcp@latest`     | never loaded      |

MEASURED on this host: cold `npx -y chrome-devtools-mcp@latest` = **111s**; `node` starting
a bind-mounted script = **1s**.

### Fix direction (needs a decision — base-image rebuild)

Bake chrome-devtools-mcp into `packages/worker/sandbox-image/Dockerfile` (currently
`node:24-bookworm-slim` + a small apt set) at a pinned default version, and have
mcp-config invoke the INSTALLED binary when no per-repo version pin is set, falling back
to `npx -y chrome-devtools-mcp@<pin>` only when a repo explicitly pins a different one.

Cost: rebuilding `haive-cli-sandbox:latest` invalidates every derived per-CLI image
(they are all `FROM haive-cli-sandbox:latest`), so this is not a free change.

Cheaper alternatives considered and rejected:
- A shared npm cache volume — helps the SECOND run, not the first.
- Pinning `chrome_devtools_mcp_version` — still downloads; the pin is not a cache.
- Telling the agent to wait longer in the prompt — model-dependent, and 111s is a long
  time to hold an agent idle even when it works.

### Separate observation, worth its own check

`SANDBOX_CHROME_PATH = '/usr/bin/chromium'` is passed as `--executable-path` on the
HEADLESS fallback path, but the sandbox base image installs no chromium (its apt set is
ca-certificates, curl, git, nano, ripgrep, tini, tmux). So the headless fallback looks
like it cannot work either. Not exercised on this run (we had a runner CDP URL, so the
browser-url branch was taken) — verify before relying on it.

---

## F9 — DAG issue branches survive worktree cleanup

**Severity: low (clutter). FIXED — commit `53aa478`.**

`12-worktree-cleanup` with `action: merge_remove, deleteBranch: true` removed all six
worktrees and deleted the INTEGRATION branch, but left all five per-issue branches:

    feature/harden-the-admin-dashboard--ISSUE-001 .. --ISSUE-005

MEASURED: `git branch --merged HEAD --list '*--ISSUE-*'` returns all 5, so they are
fully merged and safe to delete — they just are not. Five dead refs accumulate per DAG
task, and the naming (`<branch>--ISSUE-00N`) makes them easy to identify.

Not a correctness problem: the work is merged, and `git worktree prune` already ran (no
worktrees left). Purely refs left behind.

**Fix direction:** when `deleteBranch` is set and the mode was DAG, delete the issue
branches too — but ONLY those the merge actually absorbed (`--merged`), never a branch
whose issue ended `failed_unrecoverable`, whose work would then be unreachable.

---

## F5 — Runbook: `docker inspect StartedAt` does not detect a tsx reload

**Severity: none (process note). Worth recording so it is not re-learned.**

While checking whether a concurrent edit had reaped an in-flight CLI, `StartedAt` was
used as the signal. It is the WRONG signal: tsx reloads the worker process INSIDE the
container, leaving the container's `StartedAt` unchanged. A reload would have been missed.

Reliable signals instead:

- worker process uptime inside the container (`ps -eo pid,etime` on the node PIDs), or
- `cli_invocations` rows with `started_at` set, `ended_at` null and `superseded_at` set.

Related: a global pause going `true` does NOT mean the queue is quiet. A pause stops new
pickups; in-flight invocations keep running. The drain signal is
`started_at IS NOT NULL AND ended_at IS NULL AND superseded_at IS NULL` reaching zero.
MEASURED: those two moments were about four minutes apart on this run.

---

## Ordering

1. F6 (smallest, self-contained, and it currently fails a task outright)
2. F1 (agreed; unblocks the compaction path and closes the 03/04 gap)
3. F4 (trivial, same file as F1)
4. F2 (independent; needs orchestrator diagnosis, do not fold into F1)
5. Then the DAG verification run — see below
6. F3 folds into a `full_workflow` run whenever one is next needed

## Still outstanding from the original plan

DAG verification (plan step 5) is NOT done. `06b-sprint-planning` chose `single`, so
`06c-dag-execute` skipped and none of the DAG-specific code ran: the `.haive/spec.md`
copy in `createIssueWorktree`, `DagCoderContext.spec`, and the ledger at the coder
dispatch.

`06-run-config` offers no force-DAG option (only `proceed` / `use_single_agent`), so the
task must be shaped to clear the planner's own bar. `PLANNER_RULES` prefers single by
default and asks for DAG only on multiple independent functional areas, >= 4 acceptance
criteria spanning different concerns, clear parallelization, high complexity.

The structured-logging task hit the SINGLE criteria exactly (3 files, one functional
area). A candidate that should clear the DAG bar on the same repo: harden the admin
dashboard — CSRF tokens on all forms, rate-limit the login endpoint, an audit log for
admin actions, and input validation on the file-upload handler. Four independent
concerns, four areas, obvious parallelization.
