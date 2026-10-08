import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { interpretCliFailure } from '../src/queues/cli-exec/exec-core.js';
import {
  capabilityClassFromMessage,
  isOutputTruncationMessage,
} from '../src/queues/cli-exec/failure-class.js';
import { shouldRetryMiningTerminalFailure } from '../src/step-engine/mining-failure.js';
import type { AgentMiningResult } from '../src/step-engine/step-definition.js';

/** Recordings of how a reply cut at the output limit reaches Haive, fed through the shipped
 *  parsers. claude-ceiling.ndjson is claude-code 2.1.294 against ollama with
 *  CLAUDE_CODE_MAX_OUTPUT_TOKENS=64, thinking_tokens events dropped. */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');

function collect(raw: string) {
  const c = createStreamJsonCollector();
  c.onChunk(raw);
  return { result: c.getResult(), reason: c.getNoResultReason() };
}

const failedOutcome = (errorMessage: string | null) => ({
  exitCode: 1,
  rawOutput: '',
  parsedOutput: null,
  errorMessage,
});

describe('claude binary at its output ceiling (never the truncation headline)', () => {
  const { result, reason } = collect(read('truncation/claude-ceiling.ndjson'));

  it('ends as a run-level api_error, not a truncation', () => {
    expect(result).toBeNull();
    expect(reason).toMatch(
      /^LLM run reported a failure \(terminal_reason "api_error"\): API Error:/,
    );
    expect(isOutputTruncationMessage(reason)).toBe(false);
  });

  it('is classified as the output-cap capability class the step runner remediates', () => {
    const message = interpretCliFailure(failedOutcome(reason), 'ollama');
    expect(capabilityClassFromMessage(message)).toBe('output_cap_reached');
    expect(isOutputTruncationMessage(message)).toBe(false);
  });

  it('is re-rolled by a mining agent through the api_error stamp the capability message embeds', () => {
    const message = interpretCliFailure(failedOutcome(reason), 'ollama');
    const agent = { agentId: 'a', status: 'failed', errorMessage: message, rawOutput: '' };
    expect(shouldRetryMiningTerminalFailure(agent as unknown as AgentMiningResult)).toBe(true);
  });
});

describe('claude binary normal success', () => {
  it('stays a result with no failure reason', () => {
    const { result, reason } = collect(read('streams/ollama.jsonl'));
    expect(result).not.toBeNull();
    expect(reason).toBeNull();
  });
});

describe('amp truncation (error_during_execution + error "max_tokens", commit 86f53d5b)', () => {
  it('is the truncation headline and survives interpretCliFailure', () => {
    const { reason } = collect(
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n` +
        `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, error: 'max_tokens' })}\n`,
    );
    expect(isOutputTruncationMessage(reason)).toBe(true);
    const message = interpretCliFailure(failedOutcome(reason), 'amp');
    expect(isOutputTruncationMessage(message)).toBe(true);
    expect(capabilityClassFromMessage(message)).toBeNull();
  });
});
