import { beforeEach, describe, expect, it, vi } from 'vitest';

const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));

import { executeCliSpec } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
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

/** The Clean tab replays cli_invocations.raw_output as the model's answer, so a failed run's
 *  partial reply must not be stored there; the Raw stream (streamLog) keeps it. */
describe('a failed codex run does not store its partial reply as the answer', () => {
  it('exec: cut at the output limit', async () => {
    runInSandbox.mockImplementationOnce(execRun(execFixture, 1));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(outcome.rawOutput).toBe('');
    expect(outcome.parsedOutput).toBeNull();
    expect(outcome.streamLog).toContain(PARTIAL);
  });

  it('exec: a failed turn that was not a truncation', async () => {
    const failed = [
      { type: 'item.completed', item: { type: 'agent_message', text: PARTIAL } },
      { type: 'turn.failed', error: { message: 'something else broke' } },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join('');
    runInSandbox.mockImplementationOnce(execRun(failed, 1));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(outcome.rawOutput).toBe('');
    expect(outcome.streamLog).toContain(PARTIAL);
  });

  it('exec: keeps the partial reply of a run killed before it finished', async () => {
    const withoutFailure = execFixture
      .split('\n')
      .filter((l) => !l.includes('turn.failed'))
      .join('\n');
    runInSandbox.mockImplementationOnce(execRun(withoutFailure, 137));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(outcome.rawOutput).toBe(PARTIAL);
  });

  it('exec: keeps the answer of a successful run', async () => {
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n` +
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } })}\n` +
      `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })}\n`;
    runInSandbox.mockImplementationOnce(execRun(stdout, 0));
    const outcome = await executeCliSpec(execSpec(), defaultDeps, 60_000);
    expect(outcome.rawOutput).toBe('DONE');
    expect(outcome.errorMessage).toBeNull();
  });

  it('app-server: a turn that failed', async () => {
    runInSandbox.mockImplementationOnce(
      failedAppServerTurn("You've hit your usage limit.", PARTIAL),
    );
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(outcome.rawOutput).toBe('');
    expect(outcome.streamLog).toContain(PARTIAL);
  });
});
