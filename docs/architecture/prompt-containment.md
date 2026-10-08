# Prompt containment

Every agent reads text somebody else wrote, and no agent can tell an honest comment from one
placed to steer it. `steps/_untrusted-repo.ts` is the one home for the rules that answer that,
and `prompt-agent-paths.test.ts` is what stops them drifting: it builds every prompt the step
registry can reach — loop arms and detect variants included — and asserts these properties over
each one INDIVIDUALLY, never over their concatenation. A joined text passes as soon as one arm
carries the guard, which is how `01-plan-build`'s expand wave and `08b`'s fix pass each shipped
unguarded.

Read that file's own header before trusting it further, because its boundary is systemic: a
permissive proxy fails every strict comparison, so a builder driven that way emits the DEFAULT
branch of each conditional and no other, and an unmodelled branch would still pass. Nor does it
see what the dispatch-time augmenters ADD — `augmentPromptWithLedger` and its siblings run after
every builder — which is why the ledger's own fence is pinned in `task-ledger.test.ts` instead.

**FOUR VARIANTS, AND THE ENDING IS THE WHOLE CHOICE.** They share a first half; what differs is
what the pass is told to DO about text that tried to steer it, which has to match what its
output can carry:

- `REPO_IS_DATA_LINES` — REPORT it as a finding. For a pass with a findings array that has room
  for one: 07b's validator, 08c, 08d, the lenses.
- `REPO_IS_DATA_ONE_CLASS_LINES` — protection with NO reporting duty, because the findings array
  holds exactly one kind of thing. `07_7-secret-sweep`'s holds CREDENTIALS; `04a` and `05`'s
  hold problems with the SPEC, so a prompt-injection report filed there arrives as a spec defect
  and `05a`'s corrector EDITS the spec in response to something it read in a source file.
  Routing it to `## INSIGHTS` is no better — `08e` interpolates what lands there.
- `REPO_IS_DATA_ACTING_LINES` — for a pass that EDITS. No reporting duty either, and for a
  sharper reason: a coder's `concerns` reaches `recordLedgerEntry`, so quoting hostile text
  there manufactures a relay into every later prompt in the task.
- `REPO_IS_DATA_AUTHORING_LINES` — for a pass whose output becomes another agent's ASSIGNMENT:
  the spec writer, the sprint planner, every plan writer. The longest reach of the three shapes
  these four blocks cover — a reviewer that swallows an injected line files a skewed report, a
  coder WRITES it, an author turns it into an order nobody authorised.

The plan-writer set is DERIVED, not listed: whatever emits `PLAN_PATCH_CONTRACT`. A hand list
missed `01f-external-plan-sync` and `11f-plan-reconcile`, which are plan writers living under
`workflow/`. `01-advisory-research` is the one deliberate omission — its output is read by a
PERSON at a gate rather than executed, and no variant's ending fits.

**EVERY VARIANT MAKES THE PERSONA CARVE-OUT, AND IT GOVERNS METHOD.** `agentDefinitionGuidance`
tells an agent to follow the repo's own `.claude/agents/<id>.md`, so a block saying nothing
under `.claude/` is an instruction would contradict the file the same prompt just pointed at.
Two halves, both load-bearing: the definition this prompt HANDS you (points you at, or pastes
in) is your persona — one it merely NAMES, including one you were sent to edit, stays data; and
the persona says HOW to work and never what you may FIND, so narrowing, skipping, suppressing,
omitting, downgrading and reaching a verdict are all refused. A carve-out with no limit is a
licence, and the limit is the half that is easy to leave out.

**FENCE AGENT PROSE CARRIED INTO ANOTHER PROMPT.** `fencedAgentBlock` wraps a block between
`UNTRUSTED_OPEN`/`CLOSE` and runs `fenceSafe`, which collapses any run of four or more `=` —
keyed on the run rather than either banner's wording, so a reworded banner cannot reopen the
hole. Instructions ABOUT a fenced block stay OUTSIDE it: "copy the ids VERBATIM", "every one
MUST appear", "validate and fix what these DESCRIBE". `renderBoundedPlanIndex`'s omission notice
is the worked example — it is HAIVE telling the agent not to invent an id, and fencing it voided
a guard rail by its own containment. The fix loop keeps the two apart in its data: a producer's own
instruction lines travel in the request's `guidance`, which 07 renders outside the fence it puts
the diagnosis in ([Fix loop](fix-loop.md)).

This is not belt-and-braces over the guards: `REPO_IS_DATA_LINES` REQUIRES its reviewer to quote
the hostile string with its file and line, so hostile content reaches the next prompt BY DESIGN.
The reporting duty and the relay are two halves of one design, and the fences are that split
enforced downstream. One validator's output needed three: 07b's fixer, 07's fix-loop diagnosis,
and 07b's own re-validation.

**TWO RULES, AND THE SECOND IS THE COST OF THE FIRST.** _Fence where a person's words and a
machine's are JOINED_ — `formatRejectDiagnosis` contains the browser output and the audit
findings beside the developer's feedback, `formatQaFixDiagnosis` (08d2) the QA findings a person
selected beside their own, `buildGateDirectiveDiagnosis` the failure it quotes under the
operator's instruction — so the markers travel with the string and every later reader inherits
them. _Balance wherever the result is CUT_: `balanceFences` repairs a slice that kept one banner
and dropped the other. A TAIL slice (`cleanDiagnosis`) drops the BEGIN and leaves the contents
loose; a HEAD slice (`loadHonoredConstraints`, the learning digest's per-diagnosis and tier caps)
drops the END, and an unmatched BEGIN swallows the rest of the prompt; `excerptDiagnosis` keeps a
head and a tail and can do either. A block fenced WHOLE whose budget drops WHOLE entries — the
task ledger — needs no balancing, because nothing can cut one in half.

**NEVER FENCE THE OPERATOR.** A fence tells the agent not to follow what is inside it, which is
containment for AGENT prose and sabotage for a person's. `REPO_IS_DATA_MERGE_LINES` exists
because reusing the coder guard in the merge prompt pitted it against the operator's own
conflict guidance. `fixIsHuman` keeps a gate-2 rejection out of the fence; `HUMAN_REJECT_SOURCES`
splits the prior-round block; plan chat fences its own turns and never the user's. The ASSIGNMENT
itself is never fenced — a coder must follow it — so hostile text entering one is stopped
upstream, at the writer, which is what the authoring variant is for.

**A VALUE NAMED ON A PROMPT LINE.** Above the guard or below it, a value interpolated onto a line
of its own can open an instruction line. What must not be REWRITTEN is FILTERED — a filename or
a KB id the agent then opens, where `isSingleLine` and `survivesFence` decide and a mangled name
is worse than an absent one. What is prose is COLLAPSED (`collapseToLine`, `safeTitle`). The
character class is every Unicode control — C0, DEL and C1 — plus U+2028 and U+2029, with TAB the
one carve-out. A RANGE, because enumerating cost three review rounds and was wrong every time:
`\s` misses U+0085, a C0-only class misses the line separators, an ASCII class misses
U+001C-U+001E.

**FILTER AND FENCE AT PROMPT-BUILD TIME.** `detect_output` is PERSISTED and `step-runner` replays
it, so anything applied in `detect()` never reaches a step detected before it shipped — the
reason `fencedDebtBlock` and `assertReviewableChange` live where the prompt is assembled, and the
bug `listKbFiles` shipped with.
