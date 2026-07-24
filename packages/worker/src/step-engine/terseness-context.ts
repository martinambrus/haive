import { CONFIG_KEYS, configService, TERSENESS_LEVELS, type TersenessLevel } from '@haive/shared';

// Per-level output-style directives appended to a step's main prompt. They govern
// PROSE only: each keeps a carve-out so JSON, code, diffs, specifications, migrations,
// and security findings stay exact and complete. Reasoning (extended thinking) is a
// separate channel and is never targeted here ("squeeze the mouth, not the brain").
const DIRECTIVES: Record<TersenessLevel, string> = {
  // No directive. For models terse enough by default that the instruction is
  // bulk rather than signal — the empty string keeps the prompt byte-identical
  // to the un-augmented one.
  off: '',
  lite:
    '\n\n## Response style\n' +
    'Lead with the answer and trim filler. Keep code, JSON, diffs, specifications, and ' +
    'any required format exact and complete.',
  full:
    '\n\n## Response style\n' +
    'Be concise. Lead with the answer, then only the reasoning that matters; prefer ' +
    'fragments and lists over prose paragraphs. Be as thorough as the task needs when ' +
    'writing a specification, requirements, a migration, or a security finding. Never ' +
    'compress structured output: emit JSON, code, diffs, and any required format exactly.',
  ultra:
    '\n\n## Response style\n' +
    'Be maximally terse in prose: fragments over sentences, no preamble, no filler, do ' +
    'not restate the task. STILL emit JSON, code, diffs, specifications, migrations, and ' +
    'security findings exactly and completely — never compress or abbreviate structured ' +
    'output, code, or any required format.',
};

/** Append the global, admin-configured terseness directive to a step's main prompt.
 *  Affects the model's prose output only (structured output / code / specs are carved
 *  out in the directive text). Default level is 'full'. Read from the ~30s config
 *  cache, so a change applies to subsequent dispatches without a redeploy. */
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
