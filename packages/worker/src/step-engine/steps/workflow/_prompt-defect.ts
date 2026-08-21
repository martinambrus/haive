import { createHash } from 'node:crypto';
import type { StepGuidanceCause } from '@haive/database';

// Prompt-defect capture (plan lexical-jingling-dawn.md §1). Haive already learns
// from finished runs, but only about the user's CODE: 11-phase-8-learning requires
// a `path/to/file.ext:LINE` citation from the run, so a lesson about HOW HAIVE
// ASKED for the work is dropped by construction. This is the other half — a
// validator or reviewer that is about to send a round back may name the instruction
// defect that caused it.
//
// Modelled on INSIGHTS_INSTRUCTION (08e-insights-triage): a markdown block emitted
// AFTER the step's fenced JSON, parsed later from `cli_invocations.rawOutput`. No
// output contract changes and no extra CLI invocation — the agent that was already
// going to reject is the one that reports.

/** Appended to the prompts of the CLI-driven steps that can route a run back to
 *  implementation (07b, 08a, 08c, 08d), behind the feature switch.
 *
 *  The "omit it entirely" sentence is load-bearing, not politeness. Asked for a
 *  defect unconditionally a model always produces one — it will confabulate an
 *  instruction complaint out of a plain code bug — and every confabulation costs a
 *  human a triage decision and can end up appended to a prompt forever. Most
 *  failures have nothing to do with the wording, so silence has to be stated as the
 *  EXPECTED answer, not merely as an allowed one. */
export const PROMPT_DEFECT_INSTRUCTION = [
  'OPTIONAL: if — and only if — the failure you are reporting was caused by the INSTRUCTIONS',
  'you were given (this prompt or the task description) rather than by the code, you MAY add a',
  '`## PROMPT-DEFECT` section after your main output, one line per defect as:',
  '`- DEFECT: <cause> | <what the instruction should have said> | <evidence file:line>`',
  'where <cause> is exactly one of `prompt_ambiguity`, `missing_context`, `task_description_defect`.',
  'OMIT THE SECTION ENTIRELY for any other cause — a real code bug, a flaky environment, a model',
  'slip, or the task simply being hard. Omitting it is the correct and expected answer in almost',
  'every run; a guessed defect is worse than none, because a human then has to reject it.',
].join('\n');

/** The three causes the instruction offers, as a runtime set so a model that
 *  invents a fourth is dropped rather than stored. */
const CAUSES = new Set<string>(['prompt_ambiguity', 'missing_context', 'task_description_defect']);

export interface PromptDefect {
  /** Form-local id (`d-1`, `d-2`, …). Not stored. */
  id: string;
  /** The step that REPORTED the defect (a validator/reviewer). */
  sourceStep: string;
  cause: StepGuidanceCause;
  /** What the instruction should have said — the text that becomes the guidance. */
  guidance: string;
  /** The agent's evidence, `file:line` by convention. Display only. */
  evidence: string;
  fingerprint: string;
}

/** Hard cap on candidates surfaced to one triage form. A run that reports more
 *  than this many distinct instruction defects is reporting noise, not lessons. */
const MAX_DEFECTS = 20;

/** Longest guidance line kept. A defect worth appending to a prompt forever states
 *  one thing; anything longer is the agent re-narrating the task. Truncated rather
 *  than dropped so the human still sees what it was trying to say. */
const MAX_GUIDANCE_CHARS = 400;

// Volatile tokens stripped before hashing, identical in intent to fixLoopFingerprint's
// list (_fix-loop.ts): two reports of the SAME complaint that differ only in which
// file/line/id they cite must hash equal, or `occurrences` never increments and a
// `rejected` tombstone never suppresses the re-offer.
const FP_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FP_PATH_RE = /[/\\][^\s'"]+/g;
const FP_DIGITS_RE = /\d+/g;

/** Stable signature of a prompt defect, namespaced by the step the guidance will be
 *  ATTACHED to (not the step that reported it), because that is the key the unique
 *  index and the tombstone lookup use. Same normalisation as fixLoopFingerprint. */
export function promptDefectFingerprint(stepId: string, cause: string, guidance: string): string {
  const normalized = `${cause} ${guidance}`
    .toLowerCase()
    .replace(FP_UUID_RE, '')
    .replace(FP_PATH_RE, '')
    .replace(FP_DIGITS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${stepId}:${hash}`;
}

/** Which step's prompt a defect reported by `sourceStep` attaches to.
 *
 *  Every capture site is a step that reviews an IMPLEMENTATION and can route the
 *  run back to it, so the instruction they are complaining about is the one the
 *  implementer was given. Kept as an explicit map rather than reading
 *  PATH_REQUIRED_TARGETS: that table exists to keep execution-path filtering closed
 *  over loop targets, and borrowing it here would silently re-point this feature
 *  the next time a loop target moves. */
const GUIDANCE_TARGET: Record<string, string> = {
  '07b-phase-4-validate': '07-phase-2-implement',
  '08a-browser-verify': '07-phase-2-implement',
  '08c-code-review': '07-phase-2-implement',
  '08d-adversarial-qa': '07-phase-2-implement',
};

/** The step whose prompt guidance from `sourceStep` is appended to, or null when
 *  the reporting step has no registered target (an unknown step id — never store
 *  guidance we cannot place). */
export function guidanceTargetStep(sourceStep: string): string | null {
  return GUIDANCE_TARGET[sourceStep] ?? null;
}

/** Parse `## PROMPT-DEFECT` blocks from a list of raw agent outputs. Direct
 *  analogue of parseInsights(): the block is a markdown sibling of the fenced JSON,
 *  so it terminates at the next heading or fence. Deduped by fingerprint, capped.
 *  Lines whose cause is not one of the three offered are DROPPED — a model that
 *  invents a category has not answered the question. */
export function parsePromptDefects(outputs: { stepId: string; raw: string }[]): PromptDefect[] {
  const seen = new Set<string>();
  const out: PromptDefect[] = [];
  for (const { stepId, raw } of outputs) {
    if (!raw) continue;
    const target = guidanceTargetStep(stepId);
    if (!target) continue;
    const m = /##\s*PROMPT-DEFECT\b([\s\S]*?)(?:\n##\s|\n```|$)/i.exec(raw);
    if (!m) continue;
    for (const line of m[1]!.split('\n')) {
      const dm = /^\s*[-*]\s*DEFECT:\s*(.+)$/i.exec(line);
      if (!dm) continue;
      const parts = dm[1]!.split('|').map((p) => p.trim());
      const cause = (parts[0] ?? '').toLowerCase();
      if (!CAUSES.has(cause)) continue;
      const guidance = (parts[1] ?? '').slice(0, MAX_GUIDANCE_CHARS).trim();
      if (!guidance) continue;
      const evidence = parts.slice(2).join(' | ');
      const fingerprint = promptDefectFingerprint(target, cause, guidance);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      out.push({
        id: `d-${out.length + 1}`,
        sourceStep: stepId,
        cause: cause as StepGuidanceCause,
        guidance,
        evidence,
        fingerprint,
      });
      if (out.length >= MAX_DEFECTS) return out;
    }
  }
  return out;
}
