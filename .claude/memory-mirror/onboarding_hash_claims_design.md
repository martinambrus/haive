---
name: onboarding-hash-claims-design
description: 'What PR #183 established about hashing onboarding provenance, and what the skill-generator follow-up must not repeat'
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-21T08:20:33.811Z
---

**PR #183 (`feat/onboarding-hash-claims`) closes this for `07-generate-files` ONLY**, opened
2026-09-21. The skill generators (09_5, 09_5b) are the follow-up. Four facts from it that are
expensive to re-derive:

- **Row and step hash are CO-EQUAL, not a precedence chain.** `resolveAgentsForIndex`
  (`template-manifest.ts`) DROPS an accepted id with no spec; `resolveAgents`
  (`07-generate-files.ts`) substitutes `stubCustomAgent`. Different agent list, different index
  table, so the `agents-index` row can NEVER match the README 07 wrote — a row-wins rule
  quarantines that file out of a directory Haive owns. The row is still needed the other way:
  `02-upgrade-apply` inserts a row with the NEW hash while 07's step hash names pre-upgrade bytes.
- **`edited` requires PROVEN authorship, and a row does not prove it.** `recordOnboardingArtifacts`
  inserts one row per manifest RENDERING, so a file apply SKIPPED carries a row holding what Haive
  WOULD have written. Only a step hash proves authorship, because `writeIfAllowed` skips a
  pre-existing file and records NOTHING for it. My first rule conflated them and would have told a
  user their own untouched file was "edited since Haive wrote it"; the existing skipped-file case
  in `repo-artifact-reset.test.ts` caught it. Do not "simplify" that term away.
- **Hash only where the claimed entry IS the hashed path.** `claimPath` collapses a deeper path to
  the DIRECTORY containing it, and a directory has no content to hash — hanging the file's digest
  there makes the whole directory read as edited the moment anything inside changes.
- **One structure, never a parallel map.** `entries` is a `Map<string, string|null>` because those
  claims are RETIRED in four places; a second record of the same fact desyncs the first time one
  of those deletes is touched.

**A test on 07's side is mandatory and easy to get wrong.** Every api-side test feeds the hash
field synthetically, so without one 07 could stop emitting it and the whole api suite stays green.
MEASURED: a test using `.claude/workflow-config.json` pins NOTHING, because `workflowConfigJson`
is `JSON.stringify` plus a newline and so is already normalise-stable — removing
`normalizeContent` left it passing. Use `.claude/mcp_settings.json`, whose bytes the detect
payload supplies verbatim (`mcpSettingsFileContent` passes input through), with trailing spaces
and a blank-line run.

**The append path must not be hashed.** Root rules files hold the user's text around a marker
block; they are reconciled by `stripHaiveContent` and never reach `claimSatisfied` at all, because
`claimPath` needs a catalog-dir prefix or `.claude/` and a root path has no slash.

**For the skill follow-up:** 11d is excluded deliberately — it writes into the task WORKTREE and
those bytes reach the root through a git merge with AI conflict resolution, so a mismatch is not
evidence of a user edit. 09_5 has the content in scope at its record site; 09_5b throws its
sub-skill bodies away in the loop and needs a `renderedSubs`-style hoist; widening `repaired:
string[]` breaks replay, so use a parallel optional map like `repairedSubSkillSlugs` already does.
The three README index writes are rewritten by every later pass, so only the last writer's hash
would be valid.

See [[onboarding-reset-open-items]].
