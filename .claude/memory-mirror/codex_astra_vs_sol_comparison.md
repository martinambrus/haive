---
name: codex-astra-vs-sol-comparison
description: Parked request — compare codex gpt-6-astra against gpt-5.6-sol on output, effectivity and quality once onboarding finishes
metadata:
  type: project
---

Asked on 2026-09-13: at the END of the onboarding runs, compare codex `gpt-6-astra`
against codex `gpt-5.6-sol` on **output, effectivity and quality** — not just speed.

**Why:** two things the user found counter-intuitive while watching them mine the KB.
Astra was NOT faster than sol despite being the newer model, and Astra uses far FEWER
tokens than sol while costing noticeably MORE. So cost-per-token and tokens-per-task both
mislead here, and the open question is whether Astra's smaller spend buys equal or better
work. Measured so far on the same repo, same steps:

- `07_7-secret-sweep`: sol 1118s / 20 findings, astra 2325s… (astra 592s that round) — sol
  consistently reports more, astra's are consistently all-credential.
- `08-knowledge-acquisition`: sol 2505s, 869k fresh input, 91,992 output tokens, 31 drafts
  (212 KiB), 26 topics offered. Astra 2325s, 382k fresh input, 57,687 output tokens, 46
  drafts (536 KiB), 30 topics offered. So astra produced MORE knowledge from LESS input.

**How to apply:** do it once onboarding completes on both `603cf7f6` (sol) and `e33d3c4b`
(astra), which are the same repo cloned twice. Pull per-step duration, token split and
`cost` from `cli_invocations`, and judge QUALITY from the artifacts themselves — KB page
count and content, agent-discovery decisions, secret-sweep precision — not from counts
alone. Cost is on `cli_invocations.cost` with `billable` decided at write time; both are
subscription auth, so the real comparison is the notional counterfactual, not reported $.
Related: [[haive-pr-workflow]].
