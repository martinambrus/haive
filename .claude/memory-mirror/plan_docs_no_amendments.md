---
name: plan-docs-no-amendments
description: Plan docs in docs/plans/ must never carry "# Amendment" sections — fold new content into the section it belongs to
metadata:
  type: feedback
---

Never append an `# Amendment — <date>` section to a plan doc in `docs/plans/`. Fold the new
content directly into the body section it belongs to, and update every number, count and claim
the change invalidates.

**Why:** An amendment splits one subject across two places, so an LLM reading the plan has to
sweep back and forth to assemble it — and the body keeps stating superseded counts and budgets
while the amendment silently corrects them further down. Measured on
`docs/plans/kind-riding-dream.md`: folding its two amendments in required correcting six number
words ("fifteen" → "sixteen", a 60-invocation budget → 64, "thirteen dimensions that did not
run" → fourteen) that the body had been stating wrongly for as long as the amendments existed.

**How to apply:** Read the whole plan first, then place each piece where it belongs — pipeline
detail into that step, a new dimension/component beside its siblings, tests into the Verification
list, new files into Critical files. Use asserted string replacements (a script that fails on a
missing or non-unique anchor) so unchanged prose stays byte-exact. Then grep the file for number
words and re-derive every count and budget. Run `npx prettier --check` on the file after.

Swept 2026-09-07 (`3dc0d4b6`): all 33 amendment sections across 22 plans are folded, and the
convention is now written the other way in `docs/plans/README.md` and in the `.prettierignore`
comment above `docs/plans` — update BOTH if it ever changes again. Two traps that sweep hit: a
section grab spanning two amendments silently carries the next amendment's heading into the fold,
and a later amendment may DISPROVE an earlier one (purring's landmine recall, quiet's bandwidth
caveats), so fold to the surviving reading rather than stacking both.
Related: [[haive-pr-workflow]], [[lint-staged-partial-stage-hazard]].
