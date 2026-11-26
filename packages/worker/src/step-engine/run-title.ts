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
    const raw: unknown = llm.runTitle?.(args);
    if (raw == null) return null;
    if (typeof raw !== 'string') {
      // JS modules can bypass the synchronous SDK type. Ignore async results,
      // but observe their rejection so display metadata cannot crash the worker.
      void Promise.resolve(raw).catch(() => {});
      logger.warn({ reason: 'invalid' }, 'ignoring llm run title');
      return null;
    }
    // Preserve word boundaries across control whitespace and line separators.
    // Strip other controls (including bidi), retaining the ZWNJ/ZWJ joiners
    // needed for written languages and joined emoji.
    const clean = raw
      .replace(/[\u0009-\u000d\u0085\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/(?![\u200c\u200d])[\p{Cc}\p{Cf}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const title = Array.from(clean).slice(0, maxChars).join('').trimEnd();
    if (title) return title;
    logger.warn({ reason: 'empty' }, 'ignoring llm run title');
  } catch {
    // A callback's exception may quote source text, answers or credentials.
    logger.warn({ reason: 'threw' }, 'ignoring llm run title');
  }
  return null;
}
