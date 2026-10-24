---
name: onboarding-run-checkpoints
description: 'Index of everything parked waiting on a live onboarding, workflow or plan run — read it BEFORE the user creates such a task (some checks need inputs at creation), then whenever a step lands; close each item there'
metadata:
  node_type: memory
  type: project
  originSessionId: db976326-79c1-4b6d-a36f-0b838f225222
  modified: 2026-09-25T11:35:27.226Z
---

Several checks cannot be done without a real run and were each parked in their own memory, which
meant remembering to re-read nine files at the right moment. This is the index: when a run reaches
a step below, do the check and close the item in its own memory. Per
[[own-post-step-verification]] the check is MINE to run — arm it and report, never hand over a
SELECT.

**Trigger: BEFORE the task is created** — read this the moment the user says they are about to
start an onboarding, workflow or plan task, because these need inputs AT CREATION and cannot be
added once the task has moved on.

| Moment                 | Check                                                                                                                                                        | Detail in                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| before a WORKFLOW task | **declared verify commands (#72).** On the test repo's Tooling page set one slot Custom (a command that exists there) and one Off, so the run exercises them | [[declared-verify-commands-live-check]] |

**Trigger: a run reaches the step.** Each linked memory holds the method and the baseline.

| Step                                                | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Detail in                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `06_5-agent-discovery`                              | every LLM-written agent's frontmatter parses as YAML in every CLI's dir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [[frontmatter-yaml-recheck-next-onboarding]]                                                                                        |
| `07-generate-files`                                 | (a) same YAML parse for the generated agents and `.codex/agents/*.toml`; (b) does it SILENTLY replace a repo's pre-existing `.claude/agents` files — should `overwrite` be true for files Haive did not write?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [[frontmatter-yaml-recheck-next-onboarding]], [[onboarding-artifacts-recheck]]                                                      |
| `09_5-skill-generation`                             | (a) EVERY enabled CLI's skills dir holds `<id>/SKILL.md` with frontmatter; (b) a zero-token argv replay lists every repo skill WITH its description and no bundled noise; (c) real runs USE them (`tool_usage->'skills'`); (d) same YAML parse for SKILL.md and sub-skills; (e) agy reaches its first turn with skills+agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [[skills-recheck-all-clis-after-onboarding]], [[frontmatter-yaml-recheck-next-onboarding]], [[haive-skills-never-natively-invoked]] |
| `09_6_5-global-kb-review`                           | **THIS install only** — the 3 benchmark global-KB entries have served their purpose; purge via `DELETE /global-kb/entries/:id`, never SQL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [[global-kb-purge-pending]]                                                                                                         |
| `10-rag-populate`                                   | **THIS install, task cbf0be06 only** — once it has populated and the result was looked at, drop `haive_rag_ddevtest` from the real herplast2 DDEV postgres                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [[ddev-rag-test-db-cleanup]]                                                                                                        |
| `12-post-onboarding`                                | (a) `onboarding_artifacts` has rows, INCLUDING for the collided agent paths — otherwise overwritten legacy files are invisible to onboarding-upgrade; (b) **the commit-hook drift measurement, below**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [[onboarding-artifacts-recheck]], [[frontmatter-yaml-recheck-next-onboarding]]                                                      |
| `12-post-onboarding`                                | **the one product lever the review research found and we never pulled.** `wc -c AGENTS.md` on the onboarded repo and note the band — Codex's citation rate ran 0.9% / 26.2% / 38.6% for absent / <10KB / >=10KB across 31k findings. Then the sharper half: is the block Haive wrote CITABLE AS A VIOLATED RULE, or only tooling facts? If it is not rule-shaped, byte count is beside the point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [[invariants-doc-lever]]                                                                                                            |
| `02-plan-coverage` (after a real plan build)        | breadth-cap refusals at or near 0; baseline is 10 refused of 231 agents, all before 2026-09-19 18:24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [[plan-breadth-refusal-recheck]]                                                                                                    |
| `07-generate-files` (agents exist on disk)          | **agent isolation, VERIFICATION ITEM 1 — the capture harness.** Write `packages/worker/test/agent-listing-capture.ts` and run it in the worker container: production path (`createSandboxSpawner`, network policy `none`, the mounts `computeAgentDefinitionMasks` returns), a node recorder shipped as a `SandboxExtraFile` and started ahead of the CLI in the SAME container, per-CLI wiring (`ANTHROPIC_BASE_URL` for claude; `-c model_provider` + `-c model_providers.cap={…wire_api="responses"}` for codex; `XAI_API_BASE_URL` for grok, which also needs 200 on `GET /models` and `GET /api-key` or it exits "Not signed in"). Seven assertions, incl. three easy to miss: a write into a masked directory FAILS on `readonly`; a deny-listed untracked file inside a masked directory still lets the container start because its file mask is DROPPED not stacked; a directory removed between mask-build and container start comes back root-owned and is gone after the run. Plus an instruction sentinel fixture across `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md` and a nested copy | [[agent-isolation-open-items]]                                                                                                      |
| `09_6_4-global-kb-merge` / any time the stack is up | **global-KB TITLES vs the isolation rule (new, from #211).** The rule's seventh condition scans digest titles, and the digest is STACK-MATCHED from the SHARED global KB — so ONE entry whose title names an agent path (e.g. "Agent definitions live in `.claude/agents`") ends isolation for every dispatch on every repo matching that stack. List the titles (`GET /global-kb/entries`, never SQL) and check none contains a `.claude/agents`-shaped segment. If one does, RENAME the entry — do not narrow the rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [[mcp-server-name-escapes-isolation-scan]]                                                                                          |
| a workflow task reaching `08c`                      | **agent isolation, VERIFICATION ITEM 4 — the live check.** In `cli_invocations.stream_log`, `init.agents` holds ONLY the CLI's built-ins for 05 and the 08c reviewers, and still holds the repository's agents for 07 (which declares `file_write`); where the task has a ready LSP bridge, the reviewers' `cli_invocations.prompt` carries their persona BODIES. This is the measurement that proves the whole feature end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [[agent-isolation-open-items]]                                                                                                      |
| the SAME 08c task                                   | **#211 regression check — do NOT skip this one.** #211 added a seventh condition to `agentIsolationApplies` scanning external text (repository `mcpServers` keys, global-KB titles). If any of that text on the test repo happens to name an agent path, isolation silently STOPS ENGAGING and every symptom looks like the feature was never built. So item 4's reading is now also #211's regression test: if `init.agents` holds the repo's agents where it should hold built-ins, check the seventh condition FIRST — dump the repo's `.claude/mcp_settings.json` keys and the task's digest titles — before suspecting the mask or the switch                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [[mcp-server-name-escapes-isolation-scan]]                                                                                          |

| `07_7-secret-sweep` | **REGRESSION RISK from #215.** The one-class guard gained a persona carve-out. Its findings must still contain NO `.claude/agents/*`, `AGENTS.md` or scope-fence text — that variant exists because 9 of 23 findings were once exactly those | [[prompt-guard-fence-verification]] |
| `10_8-plan-build` | every prompt carries the authoring guard in EVERY build mode (#217 hoisted it out of the `from_repo` gate), and the plan still builds normally | [[prompt-guard-fence-verification]] |
| any plan build or mirror write | `.haive-data/plan.md` unchanged for ordinary titles — `renderPlanMarkdownFrom` now collapses a title and an edge note onto one line, so only an already-broken one should differ | [[prompt-guard-fence-verification]] |
| **a WORKFLOW task, not this onboarding** | most of the containment checks need 03/04/05/07/07b/08b, which onboarding never runs. THE ONE THAT MATTERS: a plan-bearing task's 04 must still emit real `node:<uuid>` ids copied out of a now-FENCED plan index | [[prompt-guard-fence-verification]] |
| a workflow task's `07` lands (any writer step counts) | **house-rules PR8 resume check.** Count graded-eligible similarity records (`house_rules->'similarity'` status `ok`, non-null non-stale score); at 10 or more over several tasks and rules, reopen PR8 (per-rule floors, then mode on). Nothing accumulates unless an admin has ENFORCED at least one `files` rule (0 on the dev install 2026-10-11) — the user picks which, never enforce one to make data | [[house-rules-pr8-resume]] |
| a workflow task's `06-run-config` → `08-phase-5-verify` → `09-gate-2` | **declared verify commands (#72), only unit-tested so far.** 06 lists them; 08 RUNS the custom one as one shell string and skips the Off one; gate 2 does not call the Off slot a missing runner. Reset the slots to Auto after | [[declared-verify-commands-live-check]] |
| workflow `11-phase-8-learning` / `11b-kb-commit` parked on the form | the ONLY place the KB editor UI renders: edit + save a KB file in the diff viewer while the gate is open (worktree write, no root claim, stale tab gets 409) | [[fs-safe-live-verification]] |

**The next run is a COMPLETE onboarding on a NEW EMPTY INSTALLATION, all supported CLIs enabled,
ONE test repo** (the user, 2026-09-21). That closes most of the table above in one pass — but note
which rows are pinned to THIS install (the global-KB benchmark entries, the `cbf0be06` ddev
database) and will simply not exist there. Do not go looking for them on the new install and
conclude something is wrong.

**The commit-hook drift measurement — this is the DATA that decides PR-F.** PR #184 (adding
`--no-verify` to step 12's commit) was closed unmerged; a TWO-COMMIT SPLIT is the only correct
shape and is deliberately unbuilt until the drift is known to matter. Measure it at
`12-post-onboarding`, directly, rather than waiting for a reset:

1. Before the step runs, record whether the repo HAS a hook that can rewrite: `.git/hooks/pre-commit`
   present and executable, `core.hooksPath` set, or husky/lint-staged/`markdownlint` in its
   `package.json`. **No hook means the run produces NO evidence either way** — say so rather than
   reporting a clean result as proof.
2. After the commit, compare the on-disk bytes of what 07/09_5/09_5b wrote against the hashes they
   recorded (`task_steps.output` -> `wroteFileHashes`, `skillHashes`, `skillSubSkillHashes`,
   `skillReadmeHashes`, and 09_5b's `repaired*`), and against `onboarding_artifacts.written_hash`.
3. Report the COUNT that drifted, out of how many. That number is the whole decision: a handful on
   a hook-bearing repo argues for the split; zero on a repo with hooks argues the exposure is
   theoretical and F should be closed rather than built.

`normalizeContent` absorbs CRLF, trailing whitespace, blank-line runs and the final newline, so a
drift here is a real structural rewrite (list markers, heading style, JSON re-indentation), not
cosmetic. Detail in [[onboarding-reset-open-items]].

**Trigger: the run COMPLETED (not cancelled, not parked).**

- **The onboarding reset WALK, end to end in the browser** — and with it the QUARANTINE REASON
  render (PR #187), which cannot be checked any earlier: `wroteFileHashes` only exists from #183
  and no onboarding has run since, so every repo on the dev install falls back to the path claim
  and no `edited` verdict is reachable at all. On the real run, edit one generated agent or skill
  file by hand BEFORE resetting, then confirm the note reads
  `<from> → <to> (edited since Haive wrote it)` while an untouched file beside it is moved with no
  reason. VERIFIED already, on 2026-09-21: the reconciler half of #186 — a `cloning` row aged past
  the cutoff was released at worker boot (`released repositories stranded at cloning, count: 1`),
  landed on `error` with its statusMessage, and the card rendered it with Retry in its menu.
  Still the only unverified half of PRs #181/#182/#183/#185 — every piece is unit- and
  mutation-tested but nobody has watched the walk remove, keep and quarantine on a real tree. Needs a genuinely onboarded repo, which the
  install has never had. A synthetic one was deliberately declined: the assumptions about real
  step outputs ARE the thing under test, and two of them were wrong in review. What to check is
  in [[onboarding-reset-open-items]]; note the dev stack serves MAIN, so pull first.
- **codex astra vs sol** — compare the two models on output/effectivity/quality
  ([[codex-astra-vs-sol-comparison]]).
- **#229 (PR B) end to end, on any completed onboarding of a git repo.** Delete the repo's
  `CLAUDE.md`, run an onboarding upgrade with commit ticked: `CLAUDE.md` comes back as `@AGENTS.md`,
  `git show --stat HEAD` lists the paths `02-upgrade-apply` reports in `writtenPaths` plus the stub and
  nothing else of the user's, and a `CLAUDE.md` the repo gitignores is REPORTED and NOT committed.
  Never ran: no repository had finished onboarding. [[agent-rules-series]]
- **#252 (FU-3, once merged) on the same completed onboarding.**
  - (a) If the repo gitignores `CLAUDE.md` or `AGENTS.md`, step 12's commit leaves that file out.
    It warns `<file> is ignored by git, so it stays out of this commit` and commits the rest.
  - (b) Onboard with commit OFF, then run an upgrade with commit ticked: `git show --stat HEAD`
    includes `AGENTS.md`, because its cli-rules region was not in HEAD.
  - (c) A second upgrade with nothing changed does not stage `AGENTS.md` again.
    [[agent-rules-followups-series]]
- **#256 (FU-4, once merged) on the first completed onboarding.** Read the repo's live
  `cli-rules-block` row in `onboarding_artifacts` beside AGENTS.md's region on disk:
  - (a) `written_content` is the region alone: it starts with `<!-- haive:cli-rules -->` and holds
    no text from outside the markers. `template_content_hash` is the sha of the normalised region.
  - (b) Where 07 wrote the region (a fresh repo, or overwrite on), `written_hash` equals
    `template_content_hash`.
  - (c) Right after the run, `GET /repos/:id/upgrade-status` does not list `cli-rules` as changed.
  - Interplay with #232's elmont check below: a `conflict` there now means the region on disk is
    no render at all (07 kept an existing region), so compare the region with 07's render before
    reading it as a Part 5 failure. Already verified with the real step code on a fixture repo.
    [[agent-rules-followups-series]]
- **#232 (PR D) upgrade status + the Part 5 hash match.** `GET /repos/:id/upgrade-status`:
  - on THIS install, the FIRST of the seven elmont repos parked at `09_2` to complete (their 07
    detect holds the OLD default): `cli-rules` must show as changed, and the upgrade plan must bucket
    it `clean_update`, NOT `conflict` — `conflict` means Part 5's re-render did not equal what step
    12 recorded, i.e. the whole point of the Part 5 refinement failed;
  - on the NEW install (new default from the start): `cli-rules` must show as current.
    [[agent-rules-series]]

**Trigger: a workflow task has its app runtime up (08a, gate 2 or `99-run-app-ready`).**

- **#284 (S16) in the browser.** The Browser direct and Database access panels load their URLs
  through POST (`/tasks/:id/access-urls`, `/db-access`), and the VNC and IDE panels still connect,
  since their WebSocket upgrades come from the app's own origin. Checked before merge with curl
  only (GET 404, POST 200, nine Origin cases): no task had a runtime up. [[found-not-fixed-sweep-series]]

**Trigger: the dev stack is already up for a test onboarding** (it is a probe, not a run).

- **#280 (S13) two-provider rebuild.** With two claude-family providers on one CLI version, press
  Rebuild on both within a second: the worker log shows ONE `building sandbox image` for the tag
  plus one join, and both rows end `ready`. Deferred 2026-09-24 (Docker had been pruned and images
  were rebuilding). It costs one image build (~2 GB), so mind the host disk.
  [[found-not-fixed-sweep-series]]

- Worktree CANCEL wiring, on a THROWAWAY workflow task cancelled after `01-worktree-setup`
  (canary + triage + estimate LLM calls, so not free). [[fs-safe-live-verification]]

- The container-cleanup smoke experiment: delay the injected stub 2 s and confirm the NEW barrier
  passes every time while a pre-#179 checkout fails every time. CI green never proved that fix —
  the bug failed ~1 run in 40. [[container-cleanup-smoke-races-cancel]]

**How to apply:** at the start of a run, read this table. When a step lands, do its check, then
edit the linked memory to record the outcome and delete it if it is closed. Do not let a run pass
a step without looking — that is exactly how all of these came to be parked twice.
