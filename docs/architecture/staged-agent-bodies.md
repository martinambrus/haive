# Staged agent bodies

**A step whose agent returns DOCUMENTS must not carry them in the reply.** One fenced JSON
block holding a whole corpus hits the model's single-message ceiling, and what happens there
is not truncation — it is the model shortening its own answer to fit, which trips NO detector:
`isOutputTruncationMessage` has never matched once on this install, across every step, all
time. MEASURED on one repo, 08 inline emitted 199,202 chars on its first run and then 135,433
chars for 378,008 output tokens on its second — 3.7x the tokens of the run before it for FEWER
bytes, all of it spent shortening and re-emitting. Staged, the same step emitted 18,187 chars
with MORE content in it (29 entries, 338 sections) and wrote 30 KB files with zero failures.

`_kb-body-file.ts` owns the pattern: the agent writes each body to `KB_DRAFT_DIR`
(`.haive/kb-draft/`) and names it in the JSON, and `apply` reads it back BEFORE anything is
routed or stored, so nothing downstream learns a second shape. Four rules, each of which cost
a measured failure:

- **Inline still wins.** `sections`/`content` present is used as-is, so a model that ignores
  the contract — or a `detect_output`/step output replayed from before it existed — behaves
  exactly as it always did.
- **The dir must be handed to the sandbox user.** The worker runs as root and the CLI sandbox
  as uid 1000, so a plain `mkdir` yields `root:root 0755` and the agent writes NOTHING into it
  — MEASURED, an 8-minute run produced zero bodies. `prepareAgentWritableDir` chowns the whole
  created chain to the repo root's owner.
- **A declared-but-missing body is a FAILURE, never an empty entry.** Publishing a blank page
  under a canonical KB name is worse than failing: an empty `ARCHITECTURE.md` reads as "this
  project has no architecture" to every later reader. Failures are reported per item so one
  bad body cannot discard the fifteen beside it.
- **The drafts are deleted once filed.** `.haive/` is NOT gitignored and `12-post-onboarding`
  stages `.haive/install.json` by name, so leftovers sit in the user's `git status` for good —
  and on a repo onboarding has to `git init` itself that step stages the whole tree with
  `git add -A` and commits every draft. `discardKbDrafts` runs at the end of apply, and KEEPS
  them when a body failed to resolve, since that is the one case where the files are evidence.

Two steps use it: `08-knowledge-acquisition` (a whole KB per reply) and `09_2-qa-resolve`
(`proposedWrite.contentPath`, one proposed section per answer — the second-largest emitter in
the system at 112,718 chars; MEASURED, one step row run three times on the same questions gave
40,218 / 28,717 / 40,706 chars for 23 answers each, the middle run 29% fewer characters for 16%
MORE output tokens).

**Do NOT reach for it for every large step — most are already bounded, by a different
mechanism, and adding a second one buys nothing.** `01-plan-build`, `02-plan-coverage`,
`03-plan-sequence`, `08c` and `08d` throw `MiningWaveError` and go wave-by-wave (one pass
cannot emit 400 nodes without truncating); `09_5`/`09_5b`, `03-phase-0a` and `11d` fan out one
agent per item; `05`, `07a`, `07b` and `08a` take one item per loop iteration. What makes a
step a candidate is not its SIZE but its SHAPE: one reply carrying N document bodies, with no
per-item dispatch. `06_5-agent-discovery` has that shape on paper (`custom[].body` is a whole
agent definition) and is deliberately NOT converted — MEASURED across every run on this
install it emits ZERO custom agents, so the path is dead and the large output is its
`skipped`/`declined` reasoning instead.
