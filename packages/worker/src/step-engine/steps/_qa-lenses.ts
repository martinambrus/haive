// Single source of truth for the four QA review lenses, shared across the
// always-on code-review step (08c), the implementation validator (07b), and the
// onboarded review/QA agent templates (_agent-templates.ts). Defining them once
// here keeps the wording from drifting between the inline-prompt sites and the
// generated agent files. Imported via ../_qa-lenses.js the same way both trees
// already import ../_fenced-json.js.
//
// The four questions are a QA tester's diff-review checklist: when each call
// FAILS (not succeeds) what happens next; whether running the same code twice
// double-writes; how far a runtime failure spreads; and — the highest-value one
// — what safeguard the change should contain and simply does not.
//
// Worded neutrally so they read correctly whether the consumer is reviewing a
// diff, validating an implementation, or checking a draft spec for completeness.
// Each site supplies its own one-line header; only the questions are shared.

export const QA_LENS_QUESTIONS: readonly string[] = [
  'Error path — when a call here fails instead of succeeding, what happens next? Is the failure caught and surfaced, or does it leave a half-finished write, a leaked resource, or a stuck state?',
  'Replay — if this exact code runs twice (a retry, a double-click, or a redelivered queue message), does it double-write, double-charge, or duplicate a record? If it can, what makes it safe — an idempotency key, a dedupe check, an upsert, or a unique constraint?',
  'Blast radius — when this breaks at runtime, what breaks with it? One call site or many, one feature or the whole flow? Is the failure contained, or does it cascade to unrelated callers?',
  'Missing safeguards — what should be here and is not? A timeout on an external call, a rollback or compensating action on partial failure, a cancellation or cleanup path on abort, or a test for the failure case. The costliest bug is often a right line that should exist and simply does not — flag the absence, not only wrong lines.',
];

/** The four questions as a numbered list (no header), ready to embed in a prompt. */
export const QA_LENS_NUMBERED: string = QA_LENS_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join(
  '\n',
);
