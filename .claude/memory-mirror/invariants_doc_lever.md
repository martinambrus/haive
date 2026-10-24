---
name: invariants-doc-lever
description: "The one product lever the review-corpus research found and we have never pulled — measure the AGENTS.md onboarding leaves behind, because doc SIZE is what moved Codex's citation rate 1% to 39%"
metadata:
  node_type: memory
  type: project
  originSessionId: dc11f5ec-28cf-424a-91d6-7d4fd9d94812
  modified: 2026-09-23T06:55:25.954Z
---

The public review corpus (4,611 repos / 8,774 PRs / **34,258 findings**, harvested 2026-09-21,
`packages/worker/tmp/review-corpus.sqlite`, never committed) produced exactly one strong signal,
and it is about the REPOSITORY rather than the model:

| invariants doc at the PR's base commit | Codex findings | carried a doc citation |
| -------------------------------------- | -------------- | ---------------------- |
| absent                                 | 11,647         | **0.9%**               |
| `<10KB`                                | 11,205         | **26.2%**              |
| `>=10KB`                               | 8,541          | **38.6%**              |

Findings per PR, CONTROLLED for diff size: small 1.05 / 1.41 / 1.55, medium 2.33 / 2.81 /
**3.78 (+62%)**, large 7.2 / 6.72 / 8.43 — clean at small and medium, NOT monotonic at large.
The corpus measured `AGENTS.md` (4,090 PRs) and `CLAUDE.md` (717) — the files Codex actually
reads — never `.haive-data/knowledge_base/`. Size bands present: <2KB 954 PRs, 2-10KB 2,156,
10-50KB 1,537, >=50KB 158.

**CORRELATION, NOT CAUSATION, and I do not think this data can settle it.** A repo that maintains
a large AGENTS.md is plausibly more disciplined in ways that independently raise finding counts.

**Why:** if doc size is the lever, it is a lever the USER controls and Haive already touches —
`07-generate-files` writes AGENTS.md (a project-info block plus the merged `haive:cli-rules`
block), which is the same file the corpus measured. That makes it the only product insight the
research produced that has not been acted on.

**How to apply — at `12-post-onboarding`, on the onboarded repo:**

1. `wc -c AGENTS.md` and note which band it lands in. Note the KB total separately
   (`.haive-data/knowledge_base/`) — it does NOT count toward the Codex number, but it is what
   HAIVE's own reviewers can cite.
2. **The sharper half, and the one that decides whether size even matters:** read the block
   Haive wrote and ask whether any of it is CITABLE AS A VIOLATED RULE. Codex cites
   `AGENTS.md:L152-L152` for a rule a change broke. "Run `pnpm build`" is tooling, not a rule —
   a reviewer finding a defect has nothing to cite it against. If Haive's block is all tooling
   facts, the byte count is beside the point and the real gap is the SHAPE of what onboarding
   writes, not its size.
3. Both halves feed `INVARIANT_CITATION` (`steps/_invariant-citation.ts`, #203), which asks
   Haive's own reviewers to cite the violated documented rule. Its real-world effect is still
   unmeasured — see [[found-not-fixed-running-list]].

If step 2 says the block is rule-shaped and step 1 says the repo is under 10KB, the actionable
change is making onboarding emit more invariants. If step 2 says it is not rule-shaped, no amount
of bytes helps and the finding does not transfer.

Related: [[prompt-guard-fence-verification]], [[review-corpus-harvester]],
[[onboarding-run-checkpoints]].
