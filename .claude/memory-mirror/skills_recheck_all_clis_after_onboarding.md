---
name: skills-recheck-all-clis-after-onboarding
description: 'Once an onboarding completes (past 09_5), verify every enabled CLI really receives and uses the generated repo skills — including after the 2026-09-19 skill-listing fixes'
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-19T21:32:51.118Z
---

Asked for by the user on 2026-09-19: after an onboarding completes, test skills for ALL enabled CLIs, so that everything works as intended, the skill-listing fixes of branch `worktree-skill-listing-budget` included. Never tested yet: on the dev install no current repo had Haive-GENERATED skills in any CLI's dir; the elmont copies carry only legacy `.claude/skills` without frontmatter.

What each CLI does, MEASURED 2026-09-19 with zero-token captures ([[cli-context-capture-harness]]):

- **claude family** (claude-code, zai, ollama, muse, openrouter) reads `.claude/skills`; `Skill` is an eager tool. The listing budget (8,000 chars on a 200K model) charges bundled skills first — 1 of 18 repo skills kept its description until `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`. See [[haive-skills-never-natively-invoked]].
- **codex** reads only `<root>/.agents/skills` (walk-up), `/home/node/.agents/skills` and `$CODEX_HOME/skills/.system`, and rejects a SKILL.md without frontmatter. It has no skill tool: it lists name, description and path, and the model reads the file (its intended lazy load). Fixes: `-c skills.bundled.enabled=false`; the dead `/root/.agents/skills` user mount dropped.
- **grok** reads `.grok/skills`, `.agents/skills` and `.claude/skills` (compat), but SKIPS project skills and AGENTS.md in an untrusted folder — every Haive grok run had 0 repo skills. Fixes: `GROK_FOLDER_TRUST=0` (plus the claude-compat hooks/MCP switches off) and a read-only `/etc/grok/managed_config.toml` with `[skills] ignore` for its 23 bundled skills.
- **gemini** needs `GEMINI_CLI_TRUST_WORKSPACE` (from 0.39.1 it exits 55 without) and `--yolo` (write tools + `activate_skill`); its two built-ins are off via `skills.disabled` in the root-owned system settings file.
- amp builds its prompt server-side: not capturable offline, so only a real run can show what it lists.
- **antigravity (agy 1.2.2) ignores the workspace's `.agents/` headless** — MEASURED 2026-09-19 with Haive's exact argv and a throwaway copy of the real login (temp docker volume, removed after): only built-ins listed (skills `agy-customizations`, `antigravity-guide`; subagents `self`, `research`). It loads `~/.gemini/config/skills/<id>/SKILL.md` and `~/.gemini/config/agents/<id>/agent.md` (name/description frontmatter ONLY; flat `<id>.md` and Haive's claude keys are not loaded). Lever (branch `feat/agy-global-customizations`): `repoMirrors` mounts `.agents/skills` read-only there and re-lays each `.agents/agents/<id>.md` as `<id>/agent.md` at dispatch; `nodeOwnedDirs` pre-creates `~/.gemini/config` node-owned — without it EVERY agy run with an MCP config died before its first turn ("failed to get/create default project"), and agy had 0 real runs on the install. End-to-end check through the real code: 8/8 repo skills and 32/32 agents listed. On the next onboarding, verify agy with a real task too: its skills and agents reach it and it runs past the first turn.

Version ranges, MEASURED per downloaded build on 2026-09-19 (zero-token): claude switch from 2.1.169 plus `SLASH_COMMAND_TOOL_CHAR_BUDGET=40000` for 2.1.105-2.1.168; codex override honoured from 0.114.0 and on every offered build; grok levers on every runnable build (0.2.116+), trust gate from 1.0.25; gemini runs from 0.6.0, skills from 0.26.0. Builds below the runnable floors (grok 0.2.116, gemini 0.6.0) are no longer offered.

**How to apply:** once an onboarding with those CLIs enabled passes `09_5-skill-generation`, for EACH enabled CLI: (1) its skills dir holds `<id>/SKILL.md` with frontmatter (`resolveSkillTargetDirs` writes one mirror per enabled provider — a provider enabled later gets none); (2) a capture replay of its real argv shows every repo skill WITH its description and no bundled/system noise; (3) its real runs use them — `tool_usage->'skills'` (`invoked` for claude's `Skill`, `read` for file-reading CLIs) on that task's invocations, and for file readers, with no skill path in the prompt.
