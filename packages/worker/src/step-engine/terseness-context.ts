import { CONFIG_KEYS, configService, TERSENESS_LEVELS, type TersenessLevel } from '@haive/shared';

// Per-level output-style directives appended to a step's main prompt. Every level opens with the
// same scope: it shapes how the agent WORDS its reply and the prose it returns, and never what it
// writes into the workspace or any format it was asked for. Reasoning (extended thinking) is a
// separate channel and is never targeted here ("squeeze the mouth, not the brain").
const SCOPE =
  'This governs only how you word your reply and the prose you return (summaries, notes, ' +
  'explanations). It never shortens or restyles what you write into files — code, comments, ' +
  'documentation, knowledge-base articles, skills — nor code, diffs, JSON, specifications, ' +
  'migrations, security findings or any other required format in your reply: those stay ' +
  'complete and follow their own conventions.';

const DIRECTIVES: Record<TersenessLevel, string> = {
  // No directive. For models terse enough by default that the instruction is
  // bulk rather than signal — the empty string keeps the prompt byte-identical
  // to the un-augmented one.
  off: '',
  lite: '\n\n## Response style\n' + SCOPE + '\n' + 'Lead with the answer and trim filler.',
  full:
    '\n\n## Response style\n' +
    SCOPE +
    '\n' +
    'Be concise. Lead with the answer, then only the reasoning that matters; prefer ' +
    'fragments and lists over prose paragraphs. Be as thorough as the task needs when ' +
    'writing a specification, requirements, a migration, or a security finding.',
  ultra:
    '\n\n## Response style\n' +
    SCOPE +
    '\n' +
    'Be maximally terse in prose: fragments over sentences, no preamble, no filler, do ' +
    'not restate the task.',
};

/** Append the global, admin-configured terseness directive to a step's main prompt.
 *  Affects the wording of the model's reply only (what it writes into files and every
 *  required format are scoped out in the directive text). Default level is 'full'. Read
 *  from the ~30s config cache, so a change applies to subsequent dispatches without a
 *  redeploy. */
export async function augmentPromptWithTerseness(prompt: string): Promise<string> {
  try {
    const raw = await configService.get(CONFIG_KEYS.TERSENESS_LEVEL);
    // Validate against the exported level list, not a hand-written literal set —
    // a new level would otherwise silently fall back to 'full' here.
    const level: TersenessLevel = (TERSENESS_LEVELS as readonly string[]).includes(raw ?? '')
      ? (raw as TersenessLevel)
      : 'full';
    return prompt + DIRECTIVES[level];
  } catch {
    // Best-effort: a config-read failure (uninitialised configService in a unit test,
    // or a transient backend blip) must never fail the step. Skip the directive.
    return prompt;
  }
}
