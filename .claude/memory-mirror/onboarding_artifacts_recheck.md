---
name: onboarding-artifacts-recheck
description: Two onboarding questions deliberately left open until a current run passes steps 07 and 12 — whether legacy .claude/agents files are silently overwritten, and whether onboarding_artifacts is populated
metadata:
  type: project
---

Deferred on 2026-09-12 because no live run had reached the steps that answer them. Check
when the elmont_rs test runs (or any onboarding) pass those steps, then report back.

**At `07-generate-files`:** does it surface or silently replace a repo's pre-existing
`.claude/agents/` files? MEASURED on task fe14b042: `07` wrote 77 files and skipped exactly
ONE (`CLAUDE.md`), so every Haive template at a colliding path replaced the legacy
definition with no choice offered. That repo now holds 46 agents including all three of
`drupal7-developer.md` (legacy), `drupal7-adversarial.md` (legacy) and
`drupal7-module-dev.md` (Haive). The elmont_rs clones each carry 28 legacy agents from the
pre-Haive markdown workflow, and 18 of those ids are ones Haive itself dispatches
(`business-requirements-writer`, `peer-reviewer`, `technical-spec-writer`, `test-writer`, …).
This matters because `agentDefinitionGuidance` treats an ON-DISK definition as OUTRANKING
the inline persona, so which version survives decides what those steps actually run.
`writeIfAllowed` is sound in itself (exists + `!overwrite` → skip and record in
`skippedFiles`); the open question is whether `overwrite` should be true for files Haive did
not write.

**At `12-post-onboarding`:** is `onboarding_artifacts` populated? It was EMPTY on
2026-09-12 (0 rows, 0 repos) and that is NOT a bug — two ordinary causes stacked:

- `12-post-onboarding` is the onboarding-side writer (`insert(onboardingArtifacts)`, step
  index 16), NOT `07-generate-files`. A run parked earlier was never going to have rows.
- The only four runs that ever reached 12 have had their repositories DELETED
  (`repository_id IS NULL`), and `onboarding_artifacts_repository_id_..._fk` is
  `ON DELETE CASCADE` (`confdeltype = 'c'`), so their rows went with the repos.

They HAD been written: the success path returns `rowsWritten: rows.length` and the
empty-manifest path returns a literal `0`, while all four recorded NULL — a value from
neither branch, i.e. written before that field existed — and all four have
`installManifestWritten: true`, which is only computed after the insert.

So do not re-diagnose an empty table as broken. The live question is whether the FIRST
current run to finish 12 records rows for the collided agent paths, or leaves the 18
overwritten legacy files untracked and therefore invisible to the upgrade path.

Related: [[haive-pr-workflow]]
