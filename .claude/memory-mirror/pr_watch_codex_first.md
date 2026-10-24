---
name: pr-watch-codex-first
description: PR loop checks the AI reviewers (Codex, Greptile) first; any finding → fix at once ignoring CI; reviewers out of allowance are skipped; all out → CI-only merge
metadata:
  type: feedback
---

Watch a PR reviewers-first. Reviewers are Codex and Greptile, each only while it has allowance.

- Any finding from an active reviewer settles the watch at once: ignore CI (the fix push supersedes it) and start fixing.
- Merge waits for every ACTIVE reviewer to end clean (Codex 👍; Greptile check completed with no findings and its `Reviews (N)` footer past the last push), then CI on the head sha.
- A Codex review not started in 4 min (no 👀) or still Running after 15 min: re-request `@codex review` once; if the retry is silent for 4 min or Running for 15 min, Codex counts as out for that push (user, 2026-10-24).
- A reviewer out of allowance is skipped, not waited on: check only the other one; both out → CI-only merge (say so in the report).

- Codex's clean signal is EITHER a 👍 on the PR OR a `codex-review-receipt` issue comment reading "Didn't find any major issues" naming the head sha (10 chars). MEASURED 2026-10-24 on #889 round 14: receipt only, no 👍; a 👍-only watch called it stuck 12 min after it passed. Check the summary row's `code_review.status` before re-requesting.

**Why:** user, 2026-10-24: waiting on CI before acting on findings wastes a round; and asked to include Greptile and keep skipping whichever reviewer is out of allowance (Greptile was out that day).
**How to apply:** `CODEX=1 GREPTILE=0 .claude/tmp/fnf-run/pr_watch_reviewers_first.sh PR FULLSHA SINCE_ISO` → `FINDINGS <bot> <ids>` / `CODEX_SILENT` / `CODEX_STUCK` (re-request once, rerun with RETRIED=1, which then counts Codex out and goes on to CI) / `SETTLED mode=<codex|greptile|codex+greptile|ci-only>`. Out-of-allowance tests (Codex usage-limit comment or 4 min silence; Greptile no check run in 15 min, month-long) are in [[haive-pr-workflow]]. Also written into /sonnet-sonnet and /opus-opus (step 8) and /codex-sonnet (step 6).
