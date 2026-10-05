# Review dimensions

Dimensions evaluate the requested behavior and existing project contracts. Selecting all
dimensions does not authorize new features, permission changes, module removals, translation
frameworks or tests of dependency internals. For example, installing one Drupal module calls
for installation and integration checks; the i18n dimension alone does not require translating
an activation helper's CLI messages. The mandatory task boundary takes precedence over inline
and previously generated personas (see [Agent rules](agent-rules.md)).

`REVIEW_DIMENSIONS` (`packages/shared/src/review/dimensions.ts`) is the canonical set of 14 a
change is scored against. Before it, the same names were hardcoded prose in five files across
eleven sites, worded three ways (`Privacy/Compliance` / `Privacy / Compliance` / `Privacy`;
`Internationalization` / `i18n`). The per-dimension `criteria` are lifted VERBATIM from 07b's
Step 7 — the only copy that carried criteria rather than names — and stored as ALREADY-WRAPPED
lines so `numberedDimensionBlock` only re-numbers and re-indents. That is what makes the
full-set render byte-identical to the old literal, including the 3-space vs 4-space
continuation indent for items 1-9 vs 10-14; `dimensions.test.ts` asserts the whole 32-line
table against the original, because every install that has not touched the setting still
renders it and a diff there is a prompt regression for everyone.

NOT the same list as `QUALITY_DIMENSIONS` in `05-phase-0b5-spec-quality` (`goal_clarity` …
`documentation_updates`), which scores the SPEC. Both have 14 entries and share nothing else.
That constant is deliberately untouched by this feature.

**Two levels, and the split is about WHEN each step runs.** `repositories.review_dimensions`
is the policy; `tasks.review_dimensions` is a per-task override; resolution is
task ?? repo ?? all (`resolveTaskReviewDimensions`, `step-engine/review-dimension-context.ts`,
mirroring `guidance-context.ts`). Both columns are `text[]` NULL-means-all, following
`lspServers` rather than the `jsonb().notNull().default([])` shape, because `[]` (score
nothing) and "never chosen" must stay distinguishable. The override reaches only the REVIEW
steps: discovery is index 3 and the spec writer index 4, while the run-config form is 6.05, so
those two pass `scope: 'repo'` — reading the task value there would apply a narrowing the user
makes later to a spec that was already written. Failure is OPEN (every dimension) at every
reader, because failing closed would silently produce a review that scored nothing.

**The on-disk agent definition outranks the inline persona.** 04, 05 and 08c each wrap their
prompt in `agentDefinitionGuidance`, which says "if a `.claude/agents/<id>.md` exists in the
repo, follow it; otherwise follow the protocol below" — and `technical-spec-writer`,
`spec-quality-reviewer` and `peer-reviewer` all name the full 14 on disk. Editing only the
inline TypeScript persona narrows NOTHING for an onboarded repo. Making the templates
dimension-aware is not the alternative either: their bytes are hashed against `REFERENCE_CONTEXT`
(`template-manifest.ts`) and compared at `api/routes/upgrades.ts`, so a per-repo body reads as
drifted and is reverted on the next onboarding upgrade. So `dimensionScopeOverride` is APPENDED
AFTER the persona in those three, where it is the most recent instruction, and returns `''`
when nothing is excluded — a default run emits the prompt it always did. 07b needs no such
block and is the one site filtered at the source, because it carries no agent pointer.

**A skipped dimension is disclosed, never implied.** 07b records `excludedDimensions` on every
apply return (the parse-miss one included) and gate 2 renders `## Not reviewed`, because a
dimension nobody scored yields exactly the same empty finding list as one that passed. Same
rule as `fixed` never being written to `review_findings`. Both that field and gate-2's copy of
it are OPTIONAL: step outputs and gate detect payloads are PERSISTED, so a task already parked
at gate 2 replays an object written before the field existed and must still render.

**03 filters mining personas through an explicit pair list** (`DIMENSION_ONLY_AGENTS`:
`accessibility-specialist`, `security-auditor`), never by matching the persona's `field`
frontmatter — even though `field: accessibility` and `field: security` happen to equal their
dimension ids. `field` is a grouping label with its own vocabulary (`testing`, `review`,
`quality`, `api`) that only coincidentally overlaps: `testing` and `testability` already do
not match, so keying on it would filter some dimensions and silently miss others. An agent
belongs on that list only when dropping the dimension makes the agent pointless. The level-gated
08c lenses (operational/performance/simplicity) are NOT filtered — they describe their own
remit in their own words rather than naming the 14, and the QA level is a separate explicit
choice. 08d's six adversaries are attack roles, not dimensions.

Admin surfaces: a card on the repo tooling page (`/repos/<id>/tooling`) for the policy, and a
collapsed accordion in `06-run-config` for the per-task override — the one accordion allowed on
that form, whose controls are otherwise top-level by design (see `fddd12a5`). Neither can store
an empty set: the repository PATCH answers 400, and the task form resolves both an omitted
field and a submitted-but-empty one to the policy. That multi-select is deliberately NOT
`required` — in `validateFormValues` the flag rejects an ABSENT value, which is the legitimate
"leave the policy alone" case every programmatic submitter uses (it broke the workflow smoke),
while an explicitly empty array counts as present and skips the check, so the flag failed the
good input and guarded nothing. No global `CONFIG_KEYS` kill-switch, deliberately — the default
is already "all on", so a switch would gate nothing.
