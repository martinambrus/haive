import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';

const sandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (original) => ({
  ...(await original<object>()),
  runInSandbox: sandbox,
}));
// Simulate a future account-action mapping at the classification seam. The message builder
// must consume its guidance rather than maintaining a second list of recognized codes.
vi.mock('../src/queues/cli-exec/failure-class.js', async (original) => {
  const actual = await original<typeof import('../src/queues/cli-exec/failure-class.js')>();
  return {
    ...actual,
    fatalClassFromStreamErrorCode: (code: string | null | undefined) =>
      code === 'future_account_action' ? 'auth' : actual.fatalClassFromStreamErrorCode(code),
    accountActionHintFromStreamErrorCode: (code: string | null | undefined) =>
      code === 'future_account_action'
        ? 'account action is needed: resolve the new account restriction'
        : actual.accountActionHintFromStreamErrorCode?.(code),
  };
});

import { executeCliSpec, interpretCliFailure } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import { createStreamJsonCollector, FAILURE_TEXT_LIMIT } from '../src/queues/cli-exec/stream.js';
import { fatalClassFromMessage } from '../src/queues/cli-exec/failure-class.js';

const line = (event: unknown) => JSON.stringify(event) + '\n';
const init = line({ type: 'system', subtype: 'init' });
const assistant = (text: string) =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (isError: boolean, text = 'FIRST TURN') =>
  line({ type: 'result', subtype: 'success', is_error: isError, result: text });
const rejected = line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
const tool = line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] },
});

async function run(stdout: string) {
  sandbox.mockImplementationOnce(async (opts) => {
    opts.onStdoutChunk?.(stdout);
    return { stdout, stderr: '', exitCode: 1, durationMs: 1, timedOut: false };
  });
  const outcome = await executeCliSpec(
    { command: 'cli', args: [], env: {}, outputFormat: 'claude-stream-json' },
    defaultDeps,
  );
  return { outcome, message: interpretCliFailure(outcome, 'claude-code') };
}

beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe('T747 review-1 controls', () => {
  it.each([false, true])('M1 retains plain stdout errors, prior result %s', async (prior) => {
    const { outcome, message } = await run(
      init + (prior ? result(false) : '') + assistant('Current turn') + 'Error: 401 Unauthorized',
    );
    expect(outcome.errorMessage).toContain('Error: 401 Unauthorized');
    expect(fatalClassFromMessage(message)).toBe('auth');
    expect(message).not.toContain('FIRST TURN');
  });

  it('M1 excludes plain stdout text from a completed earlier turn', async () => {
    const { message } = await run(init + '401 Unauthorized\n' + result(false) + assistant('Now'));
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('M1 keeps a failed result code when the CLI prints a plain shutdown line', async () => {
    const { outcome, message } = await run(
      init +
        line({ type: 'assistant', error: 'authentication_failed' }) +
        result(true, 'Not logged in') +
        'CLI shutting down\n',
    );
    expect(outcome.streamFailureClass).toBe('auth');
    expect(fatalClassFromMessage(message)).toBe('auth');
  });

  it.each([false, true])('L2 retains a new rejection after result is_error=%s', async (failed) => {
    const { message } = await run(
      init + result(failed) + rejected + assistant('You hit your limit') + tool,
    );
    expect(fatalClassFromMessage(message)).toBe('rate_limit');
  });

  it('L2 does not carry a previous turn rejection without a second init', async () => {
    const { message } = await run(init + rejected + result(true) + assistant('New turn'));
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it.each([assistant('More text'), tool])('L3 keeps text before a later event %s', async (next) => {
    const { message } = await run(init + assistant('API Error: 429 rate limit') + next);
    expect(message).toContain('API Error: 429 rate limit');
    expect(fatalClassFromMessage(message)).toBe('rate_limit');
  });

  it('L3 bounds the combined tail of assistant and plain stdout text', () => {
    expect(FAILURE_TEXT_LIMIT).toBe(4000);
    const c = createStreamJsonCollector(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      16,
    );
    c.onChunk(init + assistant('OLD: 1234567890') + assistant('abcdefghij') + 'tail\n');
    c.getResult();
    expect(c.getFailureText()).toBe('0abcdefghijtail\n');
  });

  it('L4 exposes the code without the unused auth predicate', () => {
    expect(createStreamJsonCollector()).not.toHaveProperty('hadAuthFailure');
  });

  it('L5 uses account-action guidance supplied with a future mapped auth code', async () => {
    const { message } = await run(
      init + line({ type: 'assistant', error: 'future_account_action' }) + result(true, 'Failed'),
    );
    expect(message).toContain('resolve the new account restriction');
    expect(message).not.toContain('claude /login');
  });
});
