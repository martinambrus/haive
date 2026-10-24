---
name: haive-skills-never-natively-invoked
description: Claude gets the Skill tool in every workflow run but most repo skill descriptions are cut by the 8K listing budget (bundled skills charged first); 0 Skill calls so far — re-check on a real workflow task
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-19T14:49:32.111Z
---

MEASURED 2026-09-18 on the dev install, claude 2.1.270:

- Workflow tasks DID run with Haive-generated skills: 159 claude runs had repo skills loaded and `Skill` offered (stored `init` events), 0 `Skill` calls. Skills were used only when the spec cited their paths (51 of 52 opening runs), then Read directly.
- `Skill` is one of the 11 eager tools even with tool search on (wire capture via [[cli-context-capture-harness]], `ENABLE_TOOL_SEARCH=true` to mimic first-party runs; a custom `ANTHROPIC_BASE_URL` alone turns tool search off).
- Listing budget = context window x 4 x 1% = 8,000 chars for claude-opus-5. Bundled skills are charged first and always keep full descriptions; project skills share the remainder greedily and the rest go name-only. Measured: 3 of 9 described (repo b34aa99d), 1 of 18 with the largest real workflow skill set. `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` gave 9/9 and 18/18 with a smaller listing. Other knobs: `SLASH_COMMAND_TOOL_CHAR_BUDGET`, settings `skillListingBudgetFraction`.
- Skills without frontmatter get their H1 as description; `.claude/commands/*.md` also show up as skills.
- Fixed in branch `worktree-skill-listing-budget` (2026-09-19): every claude-family run carries `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` (exists from 2.1.169) plus `SLASH_COMMAND_TOOL_CHAR_BUDGET=40000` (read back to 2.1.41), because 2.1.105-2.1.168 cut repo skills with no switch (2.1.150: 10 of 18). MEASURED per build: 18/18 described on 2.1.150, 2.1.236 and 2.1.270.

**Why:** the user treats skill use as an essential part of Haive. The model routes on name + description, and most descriptions never reached it.
**How to apply:** re-check pending — run a real WORKFLOW task on a repo onboarded by current Haive (after any listing fix, and after every claude version bump), then query `cli_invocations.tool_usage->'skills'` (invoked + read) for that task and confirm the listing with the capture harness. The budget logic is version-bound (binary strings `skillListingBudgetFraction`, `cappedSkills`); re-measure rather than trust these numbers after an upgrade.
