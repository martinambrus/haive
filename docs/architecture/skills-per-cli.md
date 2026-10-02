# Skills per CLI

**Every CLI with a skills mechanism needed its own lever, and each was MEASURED on the wire**:
the CLI in its own sandbox image, Haive's exact argv, and the API base URL pointed at a local
server that records the request and answers 400, so no tokens are spent. What the model receives
is only visible there — an `init` event lists skill NAMES, never the listing text.

- **claude family** reads `.claude/skills`, and `Skill` is one of its 11 eager tools. The listing
  is capped at context window x 4 x 1% (8,000 chars on a 200K model) and the binary charges its
  OWN bundled skills first: on 2.1.270, 1 of 18 repo skills kept its description.
  `CLAUDE_FAMILY_SKILLS_ENV` (steering.ts) sets `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, which
  exists from 2.1.169 and gives 18 of 18, plus `SLASH_COMMAND_TOOL_CHAR_BUDGET=40000` for the
  offered builds before it: 2.1.105-2.1.168 cut repo skills with no switch to stop it (2.1.150:
  10 of 18), and the budget restores all of them. A SKILL.md without frontmatter is listed with
  its H1 as the description.
- **codex** reads only `<root>/.agents/skills` (walk-up) and its home, REJECTS a SKILL.md without
  frontmatter, and has no skill tool: it lists name, description and path and the model reads the
  file — its intended lazy load, which 63 of 95 observable workflow runs used unprompted. Its five
  `.system` skills are off (`-c skills.bundled.enabled=false`, honoured from 0.114.0 and on every
  offered build): `skill-creator` had been pulled into 33 runs of `09_5`/`09_5b`.
- **grok** skips project skills AND AGENTS.md in an untrusted folder (from 1.0.25), and a headless
  run is never trusted: every grok run listed 0 repo skills until `GROK_FOLDER_TRUST=0`, which
  also ungates the repo's Claude-compat hooks, held off with `GROK_CLAUDE_HOOKS_ENABLED=0`. Its 23
  bundled skills are hidden by `[skills] ignore` in `/etc/grok/managed_config.toml`, grok's
  managed layer, read from outside the auth volume and mounted read-only through
  `CliCommandSpec.configFiles`, so Haive never merges into the `config.toml` grok writes itself.
- **gemini** exits 55 before its first request without `GEMINI_CLI_TRUST_WORKSPACE` (from
  0.39.1), and without `--yolo` non-interactive mode drops every tool that needs approval,
  `activate_skill` and the write tools included. Skills reach the model from 0.26.0; its two
  built-ins are switched off by name (`skills.disabled`) in the system settings file, the only
  place gemini honours it, and only while that file is ROOT-owned.
- **amp** builds its prompt server-side, so it is not capturable offline.
- **agy** (antigravity) ignores the workspace's `.agents/` in a headless run. MEASURED on 1.2.2 with
  Haive's argv and a throwaway copy of a real login: it listed only its built-in skills and
  subagents, and `--agent <name>` answered `Agent "<name>" not found`. It loads customizations
  from `~/.gemini/config` instead, so the sandbox MIRRORS them there read-only at dispatch
  (`CliCommandSpec.repoMirrors`, `queues/cli-exec/repo-mirrors.ts`). `.agents/skills` is mounted
  as it is, and each `.agents/agents/<id>.md` becomes `<id>/agent.md` with only `name` and
  `description` kept. agy loads neither a flat file nor one carrying Haive's claude keys. Both
  come from the invocation's own tree (the worktree when there is one), and nothing on disk
  changes shape. agy also needs `~/.gemini/config` owned by `node` (`nodeOwnedDirs`): Haive binds
  its MCP config there, and with the dir root-owned every print run died before its first turn
  (`failed to get/create default project`).

Every version range above was measured per downloaded build, zero-token, across the versions the
picker offers. Two feeds reach back past Haive's command line, so `minRunnableVersion`
(install-metadata) keeps those builds out of the picker and refuses a save naming one: grok
0.2.116 (`streaming-messages-json`) and gemini 0.6.0 (`--output-format`).

`resolveSkillTargetDirs` writes one mirror per ENABLED provider's `projectSkillsDir`, so a provider
enabled after onboarding has no generated skills until something rewrites them — generated skills
are outside onboarding-upgrade scope. Every lever above is version-bound vendor behaviour:
re-capture after a CLI bump before trusting it.

**Agent and skill frontmatter has to parse in every CLI's YAML, not just claude's.** Every value
goes through `yamlScalar` (`steps/_yaml-scalar.ts`): plain when it reads back as itself under
YAML 1.1 and 1.2, double-quoted otherwise, so a value that was always valid keeps its bytes and
no template hash moves. MEASURED with a plain `description:` holding `: ` (four baseline agents,
and LLM-written ones on live repos): claude 2.1.270 listed the agent, grok 1.0.34 left it out of
`spawn_subagent` without a word, and gemini 0.60.0 refused it ("YAML frontmatter parsing
failed"). A claude-only check therefore never shows the breakage. Haive's own line readers
(`_agent-loader`, `parseSkillMarkdown`, the bundle parser's `splitFrontmatter`) decode through
`unquoteYamlScalar`. Haive's own gemini runs never load `.gemini/agents` (`enableAgents:false`
returns first), but the files are committed to the repository, where gemini runs with agents on.
