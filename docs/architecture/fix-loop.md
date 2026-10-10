# Fix loop

Automatic repair diagnoses from 07b and 08c contain only unresolved high or critical findings
in project-owned code. Medium and low observations stay visible at gate 2. Host-classified
upstream findings are report-only, even when newly reachable or labelled in scope by a reviewer.
07b stops its local validator/fixer loop when such findings appear. Infrastructure defects are
never repair assignments; a blocking failure requires a user decision. A reproduced contributed
module failure can be resolved with the minimal package-manager-applied patch under the task
boundary, never by committing edited dependency source.
Older persisted validation outputs without structured issues remain report-only on replay;
a verdict and prose summary alone cannot establish a high/critical repair assignment.

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

`08-phase-5-verify`'s lint follows the same rule. A missing `vendor/bin/phpcs` (exit 127, as on a
site with no composer.json) and a phpcs run that used its whole 600 s cap read as NOT RUN with a
note, never as a failing check: no fix round can install a linter or speed one up. Gate 2 still
shows such a check as a NOT RUN row with its note and does not pre-select Approve, and the learning
step names it beside "passed": 08's own verdict counts only what ran. Only the clock tells a DDEV
kill from an exit 1, so the step times the flagged run rather than reading its exit.
And the verdict itself is scoped to the change: phpcs keeps its own file scope and also writes its
JSON report (`--report=full` first, since the first `--report*` flag replaces the console report,
then `--report-json` and `--basepath`) under `.haive/verify/`, which gate 3 never stages, and only
an ERROR or WARNING at a line the change wrote blocks (`_lint-scope.ts`, over the uncapped
`collectChangedLineMap`). MEASURED on a Drupal 7 clone: a change adding only clean code had blocked
on 35 violations already in the module. The diagnosis lists one `path:line` per blocking violation
and the count of pre-existing ones, telling the fixer not to clear them. The report is read whatever
phpcs exits with: a project's `ignore_errors_on_exit` or `ignore_warnings_on_exit` makes it exit 0
over violations. When the report cannot be written or read, the exit code decides as before: exit
0 passes as it is, and any other exit runs the original command again and keeps its verdict, marked
"lint verdict unscoped". A project lint script (composer or package.json), whose arguments and
output Haive does not control, is always unscoped, so those two settings decide its verdict. The trade-off: a change that makes an UNCHANGED line violate (an
import it stopped using) counts as pre-existing and does not block.

**Each fix pass is a fresh CLI process, so what earlier passes concluded has to be carried
explicitly.** `priorPassNotes` (08b) does it inside one step's loop and `loadPriorFixContext`
(`_fix-loop.ts`) does it across rounds; both dedupe with the ledger's `contentFingerprint` and
share the same budget (400 chars per entry, 4000 per block). 08b keeps the HEAD of each pass's
notes (`cutHead`), since the tester states its verdict first: MEASURED on the 29 real fix passes,
the old tail cut kept the verdict in 0 and the cause in 3, the head keeps both in 29; over the
block cap the oldest entries drop whole under one omission line. That dedupe collapses a verbatim
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
constraints, 1,500 per side of the oscillation gate and for the cap gate, 800 for 07's form, and 400 per prior-round
entry, where a person's entry is cut too because that block is background. 07b's validator report
is cut once, at 8,000, the size gate 2 shows, and records the reply's full length (`reportChars`), so
the gate shows it as stored and its marker counts what the reply lost; a row written before then is
cut again at the gate, which can count only what that second cut removed. Gate 2's manual checklist
keeps its first 12,000 characters and says how many more it does not show. A person's text stays
bounded only because each producer fences the machine part it joins to it: gate 2 does, and so
does 08d2 for the QA findings a person selects (a 500-finding "Fix all" measured 222,419 chars in
07's prompt before, 8,806 after). The fingerprints hash the whole cleaned text (`contentFingerprint`, `task-ledger.ts`):
they used to hash its last 6,000 characters, so two long diagnoses that differ only in their
opening (gate 2's words, 08c's `[high]` finding) hashed equal. A payload's
`fingerprintV2` (the whole-text hash) is trusted; a row without it is recomputed from its stored text
(`storedFingerprint`), and a text of up to 6,000 characters keeps the value it always had. `payload.fingerprint`
still holds the old tail-only hash (`legacyContentFingerprint`), because a worker from before this rule
trusts it and compares it with its own tail-only hash.

**A fix round is told when the same check sent the previous round back.** `loadSameCheckRepeat`
(`_fix-loop.ts`) compares the newest `fix_loop.requested` row of this round with the newest of the
round before, escalation-gate directives (`fix-loop-gate`) left out, and calls it a repeat only when
both name the same source. It reads events, never text, because fingerprints split on rewording. On
a repeat 07's prompt states the fact, the check and the two rounds, and quotes what that check
reported then through `excerptDiagnosis` at 2,000 characters: fenced under a line that calls it data
when an agent wrote it, never fenced for a person. It then asks the fixer to say why the earlier fix
did not hold and change approach if the defect is the same, or to say it is a different one, and
never says the earlier fix failed, since a check can fail again on a new defect. A blank previous
report is not quoted, and 07's form names the repeat in one line. Every fix round also asks for the
root cause before the edit; round 0 is unchanged. MEASURED on the dev install: 3 of 7 real fix
rounds were repeats (681f0f99 rounds 3 and 4 from 08b, ef954a3d round 5 from gate 2).

The other fixers get the same two lines (`ROOT_CAUSE_LINES`, `_fix-loop.ts`) above their failure
block: 08b's fix passes, 07b's fixer, the DAG fix coder and 08a's fixer; first passes, validator
passes and reviewer prompts are unchanged. A repeat is stated only where it can be keyed
structurally: 08b from fix pass 2 ("the tests still failed after each earlier pass", true by
construction, since its loop continues only on a failed run), 07b and the DAG fix coder when the
files flagged now overlap the previous run's (`normalizeIssueFile`), with the agent-written names
inside a fence. MEASURED on the dev install: 4 of 5 second DAG fix coders and 4 of 5 later 07b
fixer passes faced a file the previous reviewer had already flagged. 08b's outputs are NOT
compared as text: 22 of 23 consecutive fix-pass outputs differed only in a rotating dotenv tip.

**Haive's own instructions travel beside the diagnosis, never inside it.** 07 fences a machine
diagnosis whole and tells the fixer never to follow an instruction inside the fence, so whatever a
producer wrote into that string as an instruction was fenced with it: 08c's validate-then-act
paragraph and the header over its "Already tried" list, 08b's "Decide per failure" and the DDEV
guards' advice. MEASURED on the dev install: all 4 real 08b rows carried the sentence and the one
08c row opened with the paragraph. A `fixLoop` verdict, and an `AdvisedStepError` thrown into a
`fixLoopOnError` step, now hand those lines over as `guidance`: Haive's text only, never an
interpolated agent or repository value, which is why the nginx-include advice no longer names the
two files it is about (they stay in the fenced problem). `recordFixLoopRequest` stores it beside the
diagnosis only when it is non-empty, the fingerprint stays computed over the diagnosis, and 07
renders it once, outside every fence, between the root-cause request and the defect block. The key
is the field, never the wording: a request recorded before it existed renders byte for byte as
before, its instructions inside the fence. A gate directive copies the guidance of the request it
answers, and its own words still override it. A `done` row re-driven from its `error_message`
(`finishedStepResult`) carries no guidance, so that advice stays inside the fence as before. Both
escalation gates show the verdict's guidance in a closed section (the oscillation gate one per
side), under a diagnosis each bounds itself.

**A person's fix round is framed by what holds for every person source.** 07 used to tell every
`HUMAN_REJECT_SOURCES` round that a developer tested the running application and saw every problem,
which is true of gate 2 only: at 08d2 the developer picks adversarial agents' claims (the scope
defaults to all findings), and at the fix-loop gate the quoted failure is context, not an override.
The framing now says only that a person directs the fix, that their own words outside any fence are
authoritative, and that fenced text is data they attached; each producer's first lines say what kind
of review it was. 08d2 asks the fixer to validate each finding against the code first, fix the real
ones and name the rejected ones, as 08c does. The honored-constraints block in 07b's validator
prompt keeps person entries outside any fence and puts the machine entries in one fence under an
intro that still forbids reverting them; `08d-adversarial-qa`, which has not looped back since
2026-06-24, is no longer an honored source.

**A DAG issue is "stuck" when a review makes no progress, not after a fixed count.** `06c-dag-execute`
re-reviews an issue after each fix coder pass. A fix_required verdict counts as progress when it has
fewer acceptance criteria with `passed === false` than the previous verdict, and only when its
criteria list is non-empty and at least as long as the previous one: a reviewer that judged fewer
criteria would otherwise read as progress while the same failures stood. Progress resets the
stuck count to 1, anything else (an unparseable or empty criteria list included) adds one. Three
stuck reviews accept the issue with debt; five iterations mark it `failed_unrecoverable` for the
advisor. Both record the round they ended on, and `failed_unrecoverable` stores that round's review
verdict, so the advisor reads the last review rather than an earlier one. The count is keyed on the schema boolean, never on criterion wording, which varies between
rounds; MEASURED on the dev install, the file set a reviewer flags never repeated across rounds
even when the same criteria kept failing, so a file key would have turned all five debt issues into
failures. Before this, both counters rose together and the iteration cap was unreachable.

**A person-source request says whether its machine text is fenced.** Gate 2 began fencing the
runtime output and audit findings it joins to a developer's words on 2026-09-22, 08d2 its QA
findings on 2026-10-03. `recordFixLoopRequest` stamps `machineFenced: true` on every request from a
`HUMAN_REJECT_SOURCES` source; every reader that keeps a person's words outside the fences (07's
defect block, the repeat quote, the honored block, the prior-rounds block, the learning digest)
does so only for a marked row, and treats an unmarked one as machine text. Keyed on the field, never
on the wording.
