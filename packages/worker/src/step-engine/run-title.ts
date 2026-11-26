import type { LlmBuildArgs, LlmInvocationSpec, StepContext } from '@haive/shared/step';

/** cli_invocations.agent_title is varchar(256), counted in Unicode characters. */
export const MAX_RUN_TITLE_CHARS = 256;

/** Display metadata must never prevent a dispatch or put its payload in logs. */
export function resolveRunTitle(
  llm: Pick<LlmInvocationSpec, 'runTitle'>,
  args: LlmBuildArgs,
  logger: Pick<StepContext['logger'], 'warn'>,
  maxChars = MAX_RUN_TITLE_CHARS,
): string | null {
  try {
    const raw = llm.runTitle?.(args);
    if (raw == null) return null;
    if (typeof raw !== 'string') {
      logger.warn({ reason: 'invalid' }, 'ignoring llm run title');
      return null;
    }
    // Remove controls, including terminal escapes and bidi/formatting controls,
    // and Unicode line separators so a title stays a single plain-text line.
    const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
    const title = Array.from(clean).slice(0, maxChars).join('').trimEnd();
    if (title) return title;
    logger.warn({ reason: 'empty' }, 'ignoring llm run title');
  } catch {
    // A callback's exception may quote source text, answers or credentials.
    logger.warn({ reason: 'threw' }, 'ignoring llm run title');
  }
  return null;
}
