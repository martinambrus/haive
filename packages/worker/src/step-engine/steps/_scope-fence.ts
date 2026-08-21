// Single source of truth for the review SCOPE FENCE, shared across the always-on
// code-review step (08c), the implementation validator (07b), and the onboarded
// reviewer agent templates (_agent-templates.ts). Defined once here — the
// _qa-lenses.ts precedent — so the inline personas and the generated agent files
// cannot drift, since the on-disk definition OVERRIDES the inline persona via
// agentDefinitionGuidance.
//
// Why it exists. Measured across 102 runs of one task: the gating reviewers spent
// most of their effort on legacy application code the task never touched, because
// the security persona explicitly licensed it ("including pre-existing ... ones")
// and the onboarded agent file repeated that four more times. ~450 blocking
// findings sat on untouched legacy code — and a blocking finding costs a capped fix
// round, a refuter invocation, and a fix loop that then REWRITES that legacy code,
// which widens every later round (one worktree: 71 dirty files where the plan had
// 23). Every provider did it, so this is systemic rather than one CLI's quirk.
//
// The intent is unchanged: reviewers still SEE and REPORT pre-existing problems.
// What changes is what a finding outside the change costs.

/** The boundary itself, worded identically for every disposition below.
 *
 *  Blast radius is IN scope — this is the same rule 08c2's auditor already applies —
 *  so a stale caller or a broken consumer of a changed contract is never fenced out.
 *  The last line is deliberate and points the SAME way as `isOutOfScope`: doubt
 *  resolves to in-scope, so the fence can only ever be too narrow, never too wide. */
const SCOPE_BOUNDARY = [
  'SCOPE FENCE. IN SCOPE = the files this change touched, PLUS any code whose contract this',
  'change alters — a caller of a signature that changed, a consumer of a schema, format or',
  'return value that changed, and any path this change makes newly reachable. A problem in',
  'code this change did not touch and does not newly expose is OUT OF SCOPE, however real it',
  'is. If you are unsure whether this change caused it, treat it as IN scope.',
] as const;

/** Disposition A — a reviewer with a `findings` list and a `## INSIGHTS` sink.
 *  Used by peer / operational / performance / simplicity. Mirrors what
 *  08c2-code-audit already tells its auditor, so the two reviews agree on the word
 *  "finding". The sink is real: 08e scans every agent's raw output for the block and
 *  offers the insights to the developer as opt-in work. */
export const SCOPE_FENCE_INSIGHTS = [
  ...SCOPE_BOUNDARY,
  'Only an IN-SCOPE problem belongs in `findings`. A finding sends this whole change back to',
  'be reimplemented; spending that on pre-existing code the change never touched widens the',
  'change and fixes nothing it was asked to fix.',
  'A valid observation about out-of-scope code is not discarded — put it in a `## INSIGHTS`',
  'section after your main output instead, and the developer can pick it up as separate work.',
] as const;

/** Disposition B — the security reviewer, which keeps reporting everything.
 *
 *  The "author needs full information" intent is preserved verbatim: a pre-existing
 *  vulnerability is still reported IN FULL, with its attack scenario and fix. It is
 *  the `in_scope` flag, not omission, that stops it costing a fix round — and saying
 *  so plainly is what keeps the reviewer from silently under-reporting to comply. */
export const SCOPE_FENCE_IN_SCOPE_FLAG = [
  ...SCOPE_BOUNDARY,
  'Report EVERY vulnerability you find IN FULL whether it is in scope or not — with file:line,',
  'the snippet, an attack scenario and a fix — so the author can decide with full information.',
  'Then mark each one honestly: `in_scope: "yes"` ONLY for code this change introduced or',
  'altered, or for a path this change makes newly reachable; `in_scope: "no"` for anything',
  'pre-existing.',
  '`no` is ADVISORY, not ignored: the finding is recorded and shown to the developer at the',
  'approval gate, it simply does not send this change back to be reimplemented for code it',
  'never touched. Marking a pre-existing vulnerability `yes` is the failure mode to avoid.',
] as const;

/** Disposition C — the 07b implementation validator, which has no `## INSIGHTS`
 *  instruction in its prompt and whose output contract requires the JSON to be the
 *  LAST thing in its response, so pointing it at that block would name a format it
 *  was never given. Its sink is its own markdown report, which reaches the human at
 *  gate 2 while `issues` reaches a fix agent that edits files.
 *
 *  The Step 4 carve-out is load-bearing: a stale caller of something this change
 *  renamed IS in scope by definition, and the validator's protocol requires it to be
 *  fixed repo-wide. Without the carve-out this fence would contradict that step. */
export const SCOPE_FENCE_REPORT_ONLY = [
  ...SCOPE_BOUNDARY,
  'Every entry you put in `issues` is handed to a fix agent that will EDIT the code, so `issues`',
  'is for problems with THIS change only. A pre-existing problem in code this change did not',
  'touch belongs in your markdown report as an observation — never in `issues`, and never',
  'edited by you.',
  'The exception is the one your protocol already names: a stale caller of something this change',
  'renamed or removed (Step 4) is in scope wherever it lives, and you fix it.',
] as const;

/** Disposition D — the 07b validator on a DOCUMENTATION-ONLY change.
 *
 *  Disposition C cannot be reused: it ends on a carve-out naming Step 4, and the
 *  documentation protocol has no Step 4 to carve out. The boundary also needs
 *  restating rather than reusing SCOPE_BOUNDARY, because "the files this change
 *  touched" is the wrong axis here — the whole repository is legitimately in play as
 *  EVIDENCE while none of it is the work surface.
 *
 *  Measured: of 66 README runs, exactly one modified the application during a
 *  documentation task. It committed installer output, an error log and its own dev
 *  scripts alongside the README and then described them in the README as project
 *  structure — a document made true by changing the project, which is the failure
 *  this fence exists to stop. */
export const SCOPE_FENCE_DOC_REPORT_ONLY = [
  'SCOPE FENCE. This change touched documentation only. Read anything in the repository you need',
  'as EVIDENCE for a claim — that is the job — but the source code is NOT the work surface here.',
  'Every entry you put in `issues` must be a defect in the DOCUMENT, because a fix agent reads',
  'them and will edit whatever they point at. Never file an issue whose fix is a change to',
  'application code, configuration or tooling: the document is made true by correcting the',
  'document, never by changing the project to match a sentence.',
  'A real problem you notice in the code belongs in your markdown report as an observation, where',
  'the developer sees it at the approval gate — never in `issues`.',
] as const;

/** Values a reviewer uses to place a finding OUTSIDE the change. `pre-existing` is
 *  here because the agent template's own output format prints it as a gloss
 *  (`in_scope: yes | no (pre-existing)`) and reviewers echo the gloss back. */
const OUT_OF_SCOPE_WORDS = new Set(['no', 'n', 'false', 'pre-existing', 'preexisting']);

/**
 * Did the reviewer EXPLICITLY place this finding outside the change?
 *
 * True only on an explicit no. Absent, empty, unreadable, or anything this does not
 * recognise means IN SCOPE — so a reviewer that ignores the field, or a repo still
 * carrying a pre-fence agent definition, keeps today's blocking behaviour and nothing
 * silently stops blocking. The asymmetry is the same one the refuter uses: a wrongly
 * fenced-out critical is a security bug one click from shipping, while a wrongly kept
 * one costs a fix round.
 *
 * Reads the FIRST word so the template's `no (pre-existing)` gloss matches while
 * `not sure` — which starts with the same two letters — does not.
 */
export function isOutOfScope(f: { in_scope?: unknown }): boolean {
  const v = f.in_scope;
  if (v === false) return true;
  if (typeof v !== 'string') return false;
  const first =
    v
      .trim()
      .toLowerCase()
      .split(/[^a-z-]+/)[0] ?? '';
  return OUT_OF_SCOPE_WORDS.has(first);
}
