# Fix loop

A downstream step that finds a blocking defect returns `loop_back` instead of failing: the
queue bumps the round, records the diagnosis as a `fix_loop.requested` task event and
re-enters at `FIX_LOOP_TARGET_STEP_ID` (`_fix-loop.ts`), which is `07-phase-2-implement` and
is HARDCODED. Nine steps emit one (07b, 07c, 08, 08a, 08b, 08c, 08d2, 09), and 07 is the only
reader of `loadFixLoopDiagnosis`, so a round in which 07 does not run is a round in which
nobody reads the defect.

**The target is fixed; what varies is whether 07 runs.** In DAG mode
(`06b-sprint-planning.output.mode === 'dag'`) 07 used to skip at EVERY round, so every
loop_back wrote a diagnosis nothing consumed and re-ran the whole review chain against
unchanged code until the round cap. MEASURED on task 681f0f99: 07 `skipped` at rounds 1-4,
three `fix_loop.requested`/`fix_loop.started` pairs all sourced from `08b-test-management`,
none consumed. That was permanent, not transient — the loop enqueues only the target and the
forward walk never goes backwards, so 06b never re-runs and its round-0 mode stands for the
life of the task. `shouldRun` splits by ROUND instead: `06c-dag-execute` owns the initial
build (round 0 still skips), 07 owns every fix round. That is also what makes
`guidance-context.ts`'s standing claim — "a DAG-mode run gets the guidance only once the fix
loop routes back to 07" — true rather than false.

Repointing the target at `06c-dag-execute` is NOT the alternative, for four structural
reasons. `resolveDagPhase` derives its cursor as `levels.find(l => l.checkpointedAt === null)`,
so after a successful build every level is checkpointed and it resolves without dispatching an
agent; the per-issue worktrees were removed at checkpoint; `buildCoderPrompt` has no diagnosis
channel; and `PATH_REQUIRED_TARGETS` (`execution-paths.ts`) is a `Record<string, string>` that
cannot hold two targets for one emitter, with a second independent copy of the same mapping in
`_prompt-defect.ts`. The tree a fix pass must edit is `01-worktree-setup`'s integration
worktree in BOTH modes, which is exactly what 07 already uses.

**A round must not be spent on a failure no agent can repair, and that verdict has to be
reachable without a human.** `08b-test-management` is the worked example. Its fix loop is
driven by `testsPassed`, and `null` there means "not a defect" — `fixLoop.evaluate` returns
nothing, so no round is spent and a `degradedNote` reaches the person instead. Two guards
produce it, and they cover different classes: the enumerate guard (`buildCollectCommand`, a
`--list` whose non-zero exit means the runner loaded nothing) catches a LOAD failure, while
`classifyTestEnvFailure` (`_test-env-guard.ts`) reads the RUN's own output for an ENVIRONMENT
failure. The second exists because the first is structurally blind to it: Playwright builds its
list task set without `createGlobalSetupTasks`, so `--list` never runs globalSetup — MEASURED,
a container with no browser binaries listed 50 tests and exited 0 while the real run died at
`chromium.launch()`, and five consecutive fix agents each re-derived that diagnosis and wrote
it to a field nothing read. The classifier keys on error IDs Playwright raises itself
(`registry/index.js`'s "Executable doesn't exist at", `registry/dependencies.js`'s "Host system
is missing dependencies"), never on the decorative install box beside them, and claims nothing
for a framework whose output has not been measured. It applies from pass 0, unlike the
enumerate guard — a browser missing from the container is never something the tester's own
first pass could have caused.

**Each fix pass is a fresh CLI process, so what earlier passes concluded has to be carried
explicitly.** `priorPassNotes` (08b) does it inside one step's loop and `loadPriorFixContext`
(`_fix-loop.ts`) does it across rounds; both dedupe with the ledger's `contentFingerprint` and
share the same budget (400 chars per entry, 4000 per block). That dedupe collapses a verbatim
repeat but NOT two rewordings of one finding — the same limit `review_findings` measured for
prose keys — so the cap, not the dedupe, is what bounds a loop that keeps re-deriving itself.

`contentFingerprint` normalises before hashing — uuids, PATHS (everything from the first
slash) and all digits — so texts differing only in those are ONE entry. That is the intended
behaviour and MEASURED it is not over-collapsing: across all 170 real ledger entries and
diagnoses on the dev install it yields 148 fingerprints, 21 of the dupes byte-identical (the
case it exists for) and exactly ONE pair with differing text — two 08b diagnoses identical
apart from one filename in a "tests written" list, which is the same complaint. NO collision
came from the digit rule. Write test seeds accordingly: short strings differing only by a
number (`defect 1`, `defect 2`) all collapse to one entry, which real ~3000-char diagnosis
prose does not do.

**Two background blocks reach the fix prompt, and they carry different things on purpose.**
`loadPriorFixContext` carries the DIAGNOSES; the workspace/tooling facts earlier rounds
established arrive separately through `augmentPromptWithLedger` (`step-runner.ts`, ahead of
the dispatch). It used to render both in one block, ordered changes → findings → diagnoses
and head-sliced at the cap, so the diagnoses were always the part cut — MEASURED on task
681f0f99, 44 ledger entries totalling 48,523 chars against a 4000-char cap, and not one
diagnosis reached 07, the only step that reads one. The slice also defeated the ledger's own
dedupe, which suppresses an entry only on an exact text match and so missed every entry the
block had cut mid-string. Both blocks now drop WHOLE oldest entries and state the omission:
a truncated fact reads as a complete one, and the newest rounds are what the pass is
downstream of.

**A long diagnosis keeps its head as well as its tail.** A gate-2 rejection opens with the
developer's "Findings to fix (all required):" and appends the fenced runtime output and audit
after it (`formatRejectDiagnosis`), and 08c leads with its `[high]` findings, but 07 used to
receive the LAST 6,000 chars of every diagnosis (`cleanText` via `cleanDiagnosis`). MEASURED on
task ef954a3d: gate-2 rounds 4 and 5 (8,807 and 9,254 chars, the developer's words starting at
character 319) reached 07 only from char 2,807 and 3,254, and 08c's round 3 (14,676 chars) lost
its `[high]` finding. `excerptDiagnosis` (`_fix-loop.ts`) now serves every reader that shows a
diagnosis to 07 or to a person. For a person's source (`HUMAN_REJECT_SOURCES`) the text OUTSIDE
the fences — their words and Haive's framing — stays whole and only the fenced agent parts are
cut, head and tail; any other source is cut head and tail as a whole; one marker states what was
omitted and the fences stay balanced. Budgets: 6,000 for the defect block and the honored
constraints, 1,500 per side of the oscillation gate, 800 for 07's form, and 400 per prior-round
entry, where a person's entry is cut too because that block is background. A person's text stays
bounded only because each producer fences the machine part it joins to it: gate 2 does, and so
does 08d2 for the QA findings a person selects (a 500-finding "Fix all" measured 222,419 chars in
07's prompt before, 8,806 after). The fingerprints are untouched (`FINGERPRINT_TAIL_LIMIT`,
`task-ledger.ts`), so dedupe and the oscillation guard compare exactly as before.
