import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { interpretCliFailure } from '../src/queues/cli-exec/exec-core.js';
import {
  capabilityClassFromMessage,
  isFatalProviderFailure,
  isOutputTruncationMessage,
} from '../src/queues/cli-exec/failure-class.js';

/** grok 1.0.50 streaming-messages-json against a fake chat endpoint answering
 *  finish_reason "length": the result carries the signal in `stop_reason` and the text in
 *  `errors[]`, never in `error`. */
const fixture = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/truncation/grok-max-tokens.ndjson',
  ),
  'utf8',
);

function reasonOf(lines: unknown[]): string | null {
  const c = createStreamJsonCollector();
  for (const line of lines) c.onChunk(`${JSON.stringify(line)}\n`);
  return c.getNoResultReason();
}

describe('grok reply cut at max_tokens', () => {
  const c = createStreamJsonCollector();
  c.onChunk(fixture);
  const reason = c.getNoResultReason();

  it('is the truncation headline, with the errors[] detail', () => {
    expect(c.getResult()).toBeNull();
    expect(isOutputTruncationMessage(reason)).toBe(true);
    expect(reason).toContain('error_during_execution');
    expect(reason).toContain('response truncated by max_tokens');
  });

  it('survives interpretCliFailure as a truncation, not a capability or provider failure', () => {
    const message = interpretCliFailure(
      {
        exitCode: 1,
        rawOutput: '',
        parsedOutput: null,
        errorMessage: reason,
        providerErrorScan: fixture,
      },
      'grok',
    );
    expect(message).toBe(reason);
    expect(isOutputTruncationMessage(message)).toBe(true);
    expect(capabilityClassFromMessage(message)).toBeNull();
    expect(isFatalProviderFailure(message)).toBe(false);
  });
});

describe('result stop_reason is the signal, not the wording', () => {
  const result = (extra: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    ...extra,
  });

  it('classifies stop_reason max_tokens even when the errors say nothing about it', () => {
    expect(
      isOutputTruncationMessage(
        reasonOf([result({ stop_reason: 'max_tokens', errors: ['boom'] })]),
      ),
    ).toBe(true);
  });

  it('leaves another stop_reason a generic failure, whatever errors[] says', () => {
    const reason = reasonOf([result({ stop_reason: 'stop_sequence', errors: ['boom'] })]);
    expect(isOutputTruncationMessage(reason)).toBe(false);
    expect(capabilityClassFromMessage(reason)).toBeNull();
    expect(reason).toBe('LLM stream ended with result subtype "error_during_execution": boom');
  });

  it('puts errors[] in the detail of a result with no error string, for any class', () => {
    expect(reasonOf([result({ errors: ['one', ' two  words '] })])).toBe(
      'LLM stream ended with result subtype "error_during_execution": one; two words',
    );
    expect(reasonOf([result({ errors: [] })])).toBe(
      'LLM stream ended with result subtype "error_during_execution"',
    );
  });

  it('does not classify on the errors[] prose', () => {
    const reason = reasonOf([
      result({ errors: ['prompt is too long', 'cut at max_output_tokens'] }),
    ]);
    expect(isOutputTruncationMessage(reason)).toBe(false);
    expect(reason).toBe(
      'LLM stream ended with result subtype "error_during_execution": prompt is too long; cut at max_output_tokens',
    );
  });

  it('prefers the error string over errors[]', () => {
    expect(reasonOf([result({ error: 'plain', errors: ['ignored'] })])).toBe(
      'LLM stream ended with result subtype "error_during_execution": plain',
    );
  });

  it('keeps the error string of a result with no stop_reason (amp shape) unchanged', () => {
    expect(isOutputTruncationMessage(reasonOf([result({ error: 'max_tokens' })]))).toBe(true);
  });
});
