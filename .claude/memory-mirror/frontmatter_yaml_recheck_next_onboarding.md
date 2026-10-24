---
name: frontmatter-yaml-recheck-next-onboarding
description: "On the user's next single test-repo onboarding, verify every generated agent/skill frontmatter parses as YAML in every CLI and that a later renderer fix can reach the files; fix or close"
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-19T16:53:34.627Z
---

Parked on 2026-09-19 by the user, to be checked on the ONE new test repo they will onboard once
the current round of big upgrades has landed (not on the old elmont_rs copies).

Background (PR #175, `fix/frontmatter-yaml-scalars`): agent and skill frontmatter used to write
`description:` plain, so any value holding `: ` was not YAML. MEASURED zero-token: claude
2.1.270 tolerated it, grok 1.0.34 silently dropped those agents from `spawn_subagent`, gemini
0.60.0 (agents on) refused them. `yamlScalar` (`steps/_yaml-scalar.ts`) now quotes only such
values. Five live test repos still carry broken files from before the fix: elmont_rs_185
copies 0e72847d, 2c9102d9, 94a81388 (4 baseline agents in `.claude/.agents/.grok` dirs) and
9f4d4e53, e424cca3 (LLM agents from 06_5, e.g. `datatables-specialist`). They repair only on
re-onboarding: `onboarding_artifacts` was empty on this install (see
[[onboarding-artifacts-recheck]]), and 06_5 agents are outside onboarding-upgrade by design.

**How to apply** — when that onboarding passes each step, check it (own it, per
[[own-post-step-verification]]):

1. After `07-generate-files` and `06_5-agent-discovery`: every `*.md` in every agent dir
   (`.claude/agents`, `.agents/agents`, `.grok/agents`, `.gemini/agents`) parses with the `yaml`
   package to its exact `name`/`description`; `.codex/agents/*.toml` too. How it was run: a
   small node script in `haive-cli-sandbox:latest`, `--network none`, the `haive_repos` volume
   mounted read-only, and `node_modules/.pnpm/yaml@*/node_modules/yaml` mounted in for `parse`.
2. After `09_5-skill-generation`: same for every `<skills dir>/<id>/SKILL.md` and sub-skill.
3. A zero-token replay ([[cli-context-capture-harness]]) of grok and gemini (agents on) on that
   repo lists every agent — the before/after that proved the fix.
4. After `12-post-onboarding`: `onboarding_artifacts` has rows for the agent paths, so a future
   renderer fix reaches them through onboarding-upgrade. LLM agents stay untracked by design —
   if a check fails there, the question is whether they need a repair path.

Pass = all four clean → close this memory. Anything broken → fix, then close.

Related: [[skills-recheck-all-clis-after-onboarding]] (same trigger, skills listing/usage).
