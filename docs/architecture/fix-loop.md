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

A step after 07b and before gate 3 that declares `editsCodeOrTests` (the 07-family editors, and a
custom prompt step whose capabilities include `file_write`) sends the task back through validation
when it succeeds and the final change differs from 07b's stored snapshot
(`queues/validation-recheck.ts`). This is not a fix round: fresh 07c and 07b rows run at the next
round, and the return address is recorded in a `validation.recheck_requested` event, so a restart
or Retry resumes after the late step. A validation fixer that changed `.ddev/`, or a 07b whose
snapshot could not be read, hands off to 07c and then 07b the same way. Those hand-offs are bounded
per task by `maxFixRounds`; at the bound, or when the run list has no 07c before 07b, ordinary
verdict routing applies, with its cap, oscillation guard and escalation. A final snapshot that
cannot be read after two attempts fails the step retryably (`ValidationSnapshotError`).

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
Any DDEV slot that fails because its runner went away reads as NOT RUN the same way, since no agent
can bring the runner back: `execSlot` reads the runner's lifecycle before the run and again after a
non-zero exit (`ddevRunnerLife`), and a runner now gone or stopped, or one whose `StartedAt` moved (a
`docker restart` kills the exec and is up again by the time anyone looks), counts as lost. A probe
Docker could not answer says nothing, so the failure stands.
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

A root package.json lint script used to hide phpcs: lint was ONE slot, and the JS script won. When
`lint` resolves to a package.json script, verify now also resolves `phpLint` (a composer lint/phpcs/cs
script, else phpcs.xml) and runs it as a second lint with its own scoped verdict, its own `### php
lint failed` section and its own gate-2 row. The one `runLint` checkbox covers both. A repo with a
single lint runner gets no `phpLint` key, so its detect, output and gate rows are unchanged, and an
old persisted payload reads as one lint.

Detection searches only the workspace ROOT, so a repository can declare its own commands on its
Tooling page (`repositories.verify_commands`; `applyDeclaredCommands`). Per slot: a key left out
keeps detection, `null` turns the slot off, and a string replaces the runner. A declared or off lint
replaces both lint slots, `phpLint` included. A declared command runs as one shell string, `sh -c`
on the host and `ddev exec --raw -- bash -c` with the string quoted once in DDEV, so nothing in it
expands in the runner's own shell. Its verdict is unscoped, like a project script's. A declared
command whose own program cannot start reads as NOT RUN with a note, since it is a repository
setting to correct, not a defect a fix round can repair. An exit 127 or 126 alone does not prove that,
since a script that started can pass either through, so after one verify probes the command's first
word in the same environment (`command -v`, and `-x` for a path); only a probe that fails makes it NOT
RUN. A first word that is not a plain program name proves nothing, and the exit stays a failure. A failed declared test is checked for
Playwright's own missing-browser errors whatever 08b detected, since it may drive Playwright from a
directory 08b never looked in; browser provisioning still follows 08b's detection. Gate 2 lists a turned-off slot
as off, never as a missing runner, so it raises no "Tooling below the root" row, and every
root-only notice ends by pointing at the Tooling page. `06-run-config` shows the declared commands.

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
omitted and the fences stay balanced. The marker is its own paragraph, and a markdown fence a cut
splits is closed before it and reopened after it (found with `scanFences`), so the rest of a cut
report never renders as one code block (MEASURED: a 34,247-char reply's excerpt held 3 fence lines). Budgets: 6,000 for the defect block and the honored
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

**A person can change the next fix round's CLI at either escalation gate.** The round-limit
gate (`buildFixLoopEscalationSchema`) and oscillation gate
(`buildOscillationEscalationSchema`) offer The same CLI or an enabled, owned provider
that passes the implementation step's dispatch checks. This is manual only; a repeat
never switches providers automatically. The preview describes the implementation step in
the next fix round of this task, without step ids, role slots or internal round numbers.
The existing worktree stays. When no enabled provider is eligible, the selector says so
and explains that the existing CLI choice will be used.

Continue stores the choice in `task_step_cli_choices` under the task, implementation
step and `fix:<round>:default` role, inside the existing fenced transaction that closes
the gate and moves the task pointer. Accept and Abort ignore the selector. Both user
preference tables stay unchanged. With The same CLI or a legacy answer lacking the field,
dispatch follows the existing chain. Only that implementation round's default role reads
the round slot. The newest of that slot and the task's ordinary default slot wins, ordered
by PostgreSQL's full timestamp precision (the ordinary slot wins an exact tie). Thus a
step-card pick made after the gate replaces its override, including a disabled or deleted
provider; an earlier card choice stays below it. A later card clear replaces it too.

The slot expires from resolution at the next round; the row is retained, so consumed means
no longer matched, not deleted. Recovery or Retry within the target round keeps it unless
a later card pick supersedes it. Dispatch refreshes ownership and enabled state and runs
capability checks with the round provider as the sole candidate. An unusable active
override refuses dispatch visibly, with the implementation card named as a recovery action;
there is no fallback. A reoffered gate can replace the slot, or clear it with The same CLI.

A choice that becomes unusable before the gate answer is applied refuses that answer
instead of failing the task. The same transaction restores the gate's `waiting_form` status,
clears its submitted values, stamps `waiting_started_at`, refreshes the eligible options and
adds a fixed explanation to the form. It leaves the task waiting for the person, writes no
round choice or continuation event and queues no next step. The original row-ownership and
task-epoch fences still apply: an overtaken answer rolls every write back. Unrelated database
or dispatch errors still propagate.

## Test edits during a repair

The implementation fix prompt, 08b's fix passes and the DAG fix coder share
`BEHAVIOUR_FIX_LINES`: fix approved behaviour, and change an expectation only when
a named section of the spec proves it wrong. A human directive revising the spec or an
expectation takes precedence. The 08b-to-07 hand-off carries that contract once.
Final validation, related tests and review use the current tree, including test edits;
only checks that actually ran count as evidence. This phase does not replay old tests.

Before enqueueing each 07 fix invocation, 08b pass after its author pass, DAG review
fix coder, and 07b validator fixer, the host measures a complete classified-path manifest.
It captures the after manifest before consuming the ended invocation or starting another
pass. Each `fix_tests.before` / `fix_tests.after` event carries only invocation/pass/round,
manifest hash, file count, state/reason and before-event reference, never full manifests, file content, patches
or the workspace's host path. The before-event id pins that pass through later passes and
step resets. `/events` and the history digest carry only these small references, independent of repository file count.

Migration `0238_fix_test_content.sql` creates `fix_test_blobs`, keyed by task and SHA-256,
with raw content size metadata, nullable content bytea and an appended `manifest_gzip` bytea,
creation and expiry stamps, a cascading task foreign key and a partial live-content expiry index
(`expired_at IS NULL AND content IS NOT NULL`).
Only contents of changed files enter the content column. Complete manifest JSON is gzip
compressed and stored under `manifest:<SHA-256>` in the same table. Both deduplicate within
the task; pass N after and pass N+1 before share a manifest row when identical. Manifest
rows have zero content size and remain available after content expiry/eviction; task deletion
removes them. Undo the column with a later migration after reverting its readers. The migration strips experimental legacy content/patch/path payloads
and marks them unavailable rather than copying bytes whose secret policy was not checked.
Undo: revert the code first; a later migration may drop the table. Reference-only events
remain harmless. Never edit an applied migration or reconstruct old bytes from today's tree.

Before bytes are provisional worker memory, bounded to 64 MiB of raw content and 128 pending
invocations, evicting oldest pending entries. The durable before manifest survives a restart;
old bytes survive only if that hash was already retained from a previous changed file.
A restart or pending eviction can therefore leave the old side hash-only. This is disclosed
as content not retained, never replaced by a later file. Settled changed-content blobs and
both manifests remain durable. An interrupted or ownership-lost pass is not captured. Missing or undecodable manifests
also read as not captured, without preventing other passes from loading.

Both event writes lock invocation, owned step and task in that order, then storage admission
where needed; repository reads and policy resolution happen outside those transactions.
Lookups start at the invocation primary key and always constrain events by task. A replay
rechecks its event under the invocation lock. A begin that lost ownership records not captured;
a finish that lost ownership publishes no complete after record. Required event/blob write
failures prevent dispatch/settlement rather than becoming best-effort.

`_test-paths.ts` covers JS/TS, PHP, Python, Go `_test.go`, Ruby `_spec.rb` and `spec/`,
Java/Kotlin `*Test` and `src/test/`, C# `*Tests.cs`, test/fixture/snapshot/harness/e2e
directories, runner config basenames and setup files, package/build manifests, scripts
and CI workflows. This is a conservative classifier, not discovery of arbitrary commands.
Every manifest uses repository-root fs-safe held-descriptor traversal, including ignored
and untracked files, without an agent-written list. Git/Haive metadata, dependency, build,
coverage and virtual-environment trees are skipped at every depth. These skips are a blind
spot: test edits inside them are not measured or reported, even when a command runs them. A symlink, FIFO or other nonregular
classified entry refuses that path only; unrelated nonregular entries are ignored.
Two refused endpoints contribute only to a separate could-not-be-measured count, never
to changes or reviewer notices. Becoming or stopping refused is a change; retention-budget
status flips alone are not. Ordinary comparisons use content identity and mode.
An unreadable directory, over one million traversed entries or depth over 128 makes the
manifest incomplete and the pass not captured. Renames are delete/add endpoints.

The per-file content cap is 512 KiB; larger regular files are hashed in bounded chunks and
kept as hash/size/mode with content not retained. Complete manifests have no 512-file or
512-KiB aggregate cap. Provisional content allocation per capture is bounded to 64 MiB;
excess paths remain in the manifest with content not retained. The task/install durable
caps (16 MiB / 64 MiB raw content) apply only to changed content, under one database advisory
lock, shared with expiry. Both order old rows by `(created_at, task_id, content_hash)`.
An expired hit is re-stored with content, a fresh creation stamp and cleared expiry under
that same lock when it fits. Admission reads keys and integer sizes, never detoasts old content. It evicts oldest
previous live content to admit later work, preserving hashes/events and marking expiry;
content that still cannot fit stays hash-only. Thus earlier heavy tasks cannot hold later
tasks out for 30 days. The repository-sized probe captured over 2,000 paths and 23 MB while
retaining only the two changed versions. Task deletion cascades its blobs and events.

Content for any path matching the effective secret globs is withheld, including tracked
paths: capture is an at-rest copy, unlike the sandbox's untracked-only masking. The same
`taskSecretMaskPolicy` supplies per-repo allow/extend and shared carve-outs, even when masking
is switched off. `.auth/**` and storage-state JSON names are shared defaults. Policy failure
never means unrestricted capture. Policy is resolved again at finish and display; newly
denied old content is not retained or shown. Path/size/mode remain as evidence. Withheld files use only `withheld:present`, never a plain
content hash; their bytes are neither read nor hashed. Size and mode changes to withheld
files are detected; same-size content edits are not. Display replaces identities of newly denied paths with that marker.

Gate detect persists only metadata, paths and identities for at most the newest 30 passes.
Patches are loaded from retained content during form preparation, with policy resolved again;
a legacy detect patch is stripped. The resulting displayed form schema is a stored snapshot,
not a live expiry-aware view after a form has already been built. Patch text never enters events
or detect output. Newest passes receive the shared gate budget first; once it is spent no more
LCS comparisons run. Reviewer path notices load metadata only, without content or LCS. Secret-policy matchers
compile once per capture, finish or load; only changed paths are evaluated during a load.
The minute sweep's independent expiry pass removes up to 100 live contents older than
30 days per tick through the partial index, leaving hashes and expiry stamps; missing,
budgeted or expired content is explicitly hash-only. See [Worker restarts](worker-restarts.md).
