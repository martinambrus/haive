import { beforeEach, describe, expect, it, vi } from 'vitest';

const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));

import { executeCliSpec, interpretCliFailure } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import {
  CODEX_OUTPUT_LIMIT_MARKER,
  createCodexJsonlCollector,
  isCodexOutputLimitMessage,
} from '../src/cli-executor/codex-jsonl.js';
import {
  capabilityClassFromMessage,
  isFatalProviderFailure,
  isOutputTruncationMessage,
  isTransientCliFailure,
} from '../src/queues/cli-exec/failure-class.js';
import {
  appServerSpec,
  execFixture,
  execRun,
  execSpec,
  failedAppServerTurn,
  PARTIAL,
} from './support/codex-truncation-harness.js';

beforeEach(() => {
  runInSandbox.mockReset();
});

const asFailure = (outcome: Awaited<ReturnType<typeof executeCliSpec>>) =>
  interpretCliFailure(outcome, 'codex');

describe('codex reply cut at max_output_tokens (exec)', () => {
  it('fixture carries the volatile marker codex wraps around the documented reason', () => {
    expect(execFixture).toContain(CODEX_OUTPUT_LIMIT_MARKER);
    expect(CODEX_OUTPUT_LIMIT_MARKER).toBe(
      'Incomplete response returned, reason: max_output_tokens',
    );
  });

  it('is the truncation headline ahead of the stderr tail, and nothing reclassifies it', async () => {
    runInSandbox.mockImplementationOnce(execRun(execFixture, 1));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(isOutputTruncationMessage(outcome.errorMessage)).toBe(true);
    const message = asFailure(outcome);
    expect(message).toBe(outcome.errorMessage);
    expect(capabilityClassFromMessage(message)).toBeNull();
    expect(isFatalProviderFailure(message)).toBe(false);
    expect(isTransientCliFailure({ exitCode: 1, errorMessage: message })).toBe(false);
  });

  it('is the truncation headline when the cut came before any agent message', async () => {
    const lines = execFixture.split('\n').filter((l) => !l.includes('agent_message'));
    runInSandbox.mockImplementationOnce(execRun(lines.join('\n'), 1));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(isOutputTruncationMessage(outcome.errorMessage)).toBe(true);
  });

  it.each(['rate limit 429', 'HTTP 500 Internal Server Error'])(
    'stays the truncation headline when the partial reply mentions %s',
    async (mention) => {
      runInSandbox.mockImplementationOnce(execRun(execFixture.replaceAll(PARTIAL, mention), 1));
      const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
      expect(outcome.providerErrorScan).toContain(mention);
      expect(isOutputTruncationMessage(outcome.errorMessage)).toBe(true);
      expect(isOutputTruncationMessage(asFailure(outcome))).toBe(true);
    },
  );

  it('is not stored as a truncation when the run was killed', async () => {
    runInSandbox.mockImplementationOnce(execRun(execFixture, 137));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(isOutputTruncationMessage(asFailure(outcome))).toBe(false);
  });
});

describe('codex output-limit marker is read from the turn failure only', () => {
  const feed = (events: unknown[]) => {
    const c = createCodexJsonlCollector();
    for (const e of events) c.onChunk(`${JSON.stringify(e)}\n`);
    return c;
  };

  it('ignores a reconnect notice the retry then recovered from', () => {
    const c = feed([
      {
        type: 'error',
        message: `Reconnecting... 1/5 (stream disconnected before completion: ${CODEX_OUTPUT_LIMIT_MARKER})`,
      },
      { type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(c.getTurnFailure()).toBeNull();
  });

  it('ignores the marker in what the agent wrote', () => {
    const c = feed([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: `codex said: ${CODEX_OUTPUT_LIMIT_MARKER}` },
      },
    ]);
    expect(c.getTurnFailure()).toBeNull();
  });

  it('reads the turn.failed message of the measured stream', () => {
    const c = feed(
      execFixture
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
    expect(isCodexOutputLimitMessage(c.getTurnFailure())).toBe(true);
  });

  it('does not take another incomplete reason for the output limit', () => {
    expect(
      isCodexOutputLimitMessage(
        'stream disconnected before completion: Incomplete response returned, reason: content_filter',
      ),
    ).toBe(false);
  });
});

describe('codex reply cut at max_output_tokens (app-server)', () => {
  const turnError = `stream disconnected before completion: ${CODEX_OUTPUT_LIMIT_MARKER}`;

  it('is the truncation headline and nothing reclassifies it', async () => {
    runInSandbox.mockImplementationOnce(failedAppServerTurn(turnError, PARTIAL));
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(isOutputTruncationMessage(outcome.errorMessage)).toBe(true);
    const message = asFailure(outcome);
    expect(message).toBe(outcome.errorMessage);
    expect(capabilityClassFromMessage(message)).toBeNull();
    expect(isFatalProviderFailure(message)).toBe(false);
  });

  it('keeps the exec wording for a failed turn that was not a truncation', async () => {
    runInSandbox.mockImplementationOnce(
      failedAppServerTurn("You've hit your usage limit.", PARTIAL),
    );
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(outcome.errorMessage).toBe("codex turn failed: You've hit your usage limit.");
  });
});
