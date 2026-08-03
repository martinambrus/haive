import { describe, expect, it } from 'vitest';
import { interpretCliFailure } from './exec-core.js';
import {
  capabilityClassFromMessage,
  isFatalProviderFailure,
  isOutputTruncationMessage,
  isTransientCliFailure,
  MODEL_CAPABILITY_HEADLINES,
} from './failure-class.js';

// Verbatim cli_invocations.error_message values from the production incident (task
// 7780da14, step 07-phase-2-implement, ollama/deepseek-v4-flash:cloud). Both were
// surfaced raw to the user and failed the task; this asserts the whole message pipeline
// against those exact bytes.
const INCIDENT_NO_VISION =
  'API Error: 400 this model does not support image input (ref: 0c523fbc-d82b-4cba-a5e7-aa8530c019b4)';
const INCIDENT_OUTPUT_CAP =
  "API Error: Claude's response exceeded the 32000 output token maximum. To configure this " +
  'behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.';
const CEILING_REJECTED =
  'API Error: 400 max_tokens: 131072 > 64000, which is the maximum allowed number of output ' +
  'tokens for claude-sonnet-4-20250514';

/** The shape the claude binary produces for these: the API error goes to stdout and the
 *  process exits 1, so formatCliErrorMessage lifts it into errorMessage verbatim. */
const outcome = (raw: string) => ({
  exitCode: 1,
  rawOutput: raw,
  parsedOutput: null,
  errorMessage: raw,
});

describe('interpretCliFailure: model-capability messages', () => {
  it.each([
    ['no_image_support', INCIDENT_NO_VISION],
    ['output_cap_reached', INCIDENT_OUTPUT_CAP],
    ['max_tokens_too_large', CEILING_REJECTED],
  ] as const)('headlines %s so the remediation retry can find it', (cls, raw) => {
    const message = interpretCliFailure(outcome(raw), 'ollama');
    expect(message?.startsWith(MODEL_CAPABILITY_HEADLINES[cls])).toBe(true);
    expect(capabilityClassFromMessage(message)).toBe(cls);
    // The provider's own words stay in the message for the user.
    expect(message).toContain(raw.slice(0, 40));
  });

  // The built message passes through three other classifiers on the way to the retry
  // branches. Any of them matching first would route the failure somewhere that does NOT
  // remediate: transient re-runs the identical request, truncation needs llm.retry budget
  // the affected steps do not have, and fatal fails the whole task fast. The hint prose is
  // ours to edit, so this guards against a future rewording colliding with their patterns.
  it.each([INCIDENT_NO_VISION, INCIDENT_OUTPUT_CAP, CEILING_REJECTED])(
    'is claimed by no other classifier: %s',
    (raw) => {
      const message = interpretCliFailure(outcome(raw), 'ollama');
      expect(isTransientCliFailure({ exitCode: 1, errorMessage: message })).toBe(false);
      expect(isOutputTruncationMessage(message)).toBe(false);
      expect(isFatalProviderFailure(message)).toBe(false);
    },
  );

  it('leaves ordinary failures alone', () => {
    const plain = interpretCliFailure(outcome('TypeError: x is not a function'), 'ollama');
    expect(capabilityClassFromMessage(plain)).toBeNull();
    expect(plain).toBe('TypeError: x is not a function');
  });

  it('does not claim a cancelled or timed-out run', () => {
    // Termination exit codes mean the run never finished under its own power; the transient
    // path owns those, and a capability message would suppress its re-dispatch.
    const killed = interpretCliFailure(
      { ...outcome(INCIDENT_OUTPUT_CAP), exitCode: 137 },
      'ollama',
    );
    expect(capabilityClassFromMessage(killed)).toBeNull();
    expect(isTransientCliFailure({ exitCode: 137, errorMessage: killed })).toBe(true);
  });
});
