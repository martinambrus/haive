import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
const sandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (original) => ({
  ...(await original<object>()),
  runInSandbox: sandbox,
}));
import { executeCliSpec, interpretCliFailure } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import {
  PROVIDER_FATAL_HEADLINES,
  fatalClassFromMessage,
} from '../src/queues/cli-exec/failure-class.js';

/** A claude-family run with no usable login ends as a run-level api_error whose result event is
 *  subtype "success" with is_error true, exit code 1. The only thing that tells it from any other
 *  api_error is the top-level `error` field of the assistant event the binary authored. The two
 *  recordings are claude 2.1.330 with no credentials and with a rejected key; their init event's
 *  tools, slash_commands, skills and capabilities lists are shortened, nothing the collector reads
 *  is. */
const recording = (name: string) =>
  readFileSync(new URL(`./fixtures/streams/${name}.jsonl`, import.meta.url), 'utf8');
const RECORDINGS = [
  ['no login', 'claude-no-login', 'Not logged in · Please run /login'],
  ['rejected key', 'claude-rejected-key', 'Invalid API key · Fix external API key'],
] as const;

const line = (event: unknown) => JSON.stringify(event) + '\n';
const init = line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    message: {
      id: 'm',
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    ...extra,
  });
const failedResult = (text: string) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    result: text,
  });
const okResult = (text: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text });

const spawned = (stdout: string, exitCode: number) => ({
  stdout,
  exitCode,
  stderr: '',
  durationMs: 1,
  timedOut: false,
  resolvedCommand: 'cli',
  wrapperId: null,
});

async function run(stdout: string, exitCode: number, provider: string) {
  sandbox.mockImplementationOnce(async (opts) => {
    opts.onStdoutChunk?.(stdout);
    return spawned(stdout, exitCode);
  });
  const outcome = await executeCliSpec(
    { command: 'cli', args: [], env: {}, outputFormat: 'claude-stream-json' },
    defaultDeps,
  );
  return { outcome, message: interpretCliFailure(outcome, provider) };
}

const collect = (stdout: string) => {
  const c = createStreamJsonCollector();
  c.onChunk(stdout);
  return c;
};

beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe('the collector reads the CLI authentication error code', () => {
  it.each(RECORDINGS)('flags the %s recording and still reports no result', (_n, file) => {
    const c = collect(recording(file));
    expect(c.getAssistantErrorCode()).toBe('authentication_failed');
    expect(c.getResult()).toBeNull();
  });

  it('does not flag a stream whose assistant events carry no error code', () => {
    expect(
      collect(init + assistant('hello') + okResult('hello')).getAssistantErrorCode(),
    ).toBeNull();
  });

  it.each(['rate_limit', 'server_error', 'overloaded', 'billing_error'])(
    'preserves the distinct %s code',
    (code) => {
      const c = collect(init + assistant('x', { error: code }) + failedResult('x'));
      expect(c.getAssistantErrorCode()).toBe(code);
    },
  );
});

describe('a run with no usable login is classified as an authentication failure', () => {
  it.each(RECORDINGS)(
    '%s: claude-code gets the auth headline and its login hint',
    async (_n, file, text) => {
      const { outcome, message } = await run(recording(file), 1, 'claude-code');
      expect(outcome.streamFailureClass).toBe('auth');
      expect(message?.startsWith(PROVIDER_FATAL_HEADLINES.auth)).toBe(true);
      expect(message).toContain('claude /login');
      expect(message).toContain(text);
      expect(fatalClassFromMessage(message)).toBe('auth');
    },
  );

  it.each(RECORDINGS)('%s: zai gets the auth headline and its own hint', async (_n, file, text) => {
    const { message } = await run(recording(file), 1, 'zai');
    expect(message?.startsWith(PROVIDER_FATAL_HEADLINES.auth)).toBe(true);
    expect(message).toContain('zai login');
    expect(message).not.toContain('claude /login');
    expect(message).toContain(text);
    expect(fatalClassFromMessage(message)).toBe('auth');
  });
});

describe('only the structural field makes a run an authentication failure', () => {
  const TEXT = 'Not logged in · Please run /login';

  it('the same text without the error field is not classified auth', async () => {
    const { outcome, message } = await run(
      init + assistant(TEXT) + failedResult(TEXT),
      1,
      'claude-code',
    );
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('an error that was followed by a normal reply and a success exits 0 with its own message', async () => {
    const stdout =
      init +
      assistant('x', { error: 'authentication_failed' }) +
      assistant('all good') +
      okResult('all good');
    expect(collect(stdout).getAssistantErrorCode()).toBeNull();
    const { outcome, message } = await run(stdout, 0, 'claude-code');
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(message).toBe(outcome.errorMessage ?? null);
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('the same recovery followed by a different failure is not auth', async () => {
    const stdout =
      init +
      assistant('x', { error: 'authentication_failed' }) +
      assistant('retrying') +
      failedResult('something else broke');
    expect(collect(stdout).getAssistantErrorCode()).toBeNull();
    const { outcome, message } = await run(stdout, 1, 'claude-code');
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('a sub-agent turn carrying the code does not make the run an auth failure', async () => {
    const stdout =
      init +
      assistant('main') +
      assistant('sub', { error: 'authentication_failed', parent_tool_use_id: 'toolu_1' }) +
      failedResult('something else broke');
    expect(collect(stdout).getAssistantErrorCode()).toBeNull();
    const { outcome, message } = await run(stdout, 1, 'claude-code');
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('a sub-agent turn does not clear the code of the top-level turn before it', () => {
    const stdout =
      init +
      assistant('x', { error: 'authentication_failed' }) +
      assistant('sub', { parent_tool_use_id: 'toolu_1' }) +
      failedResult('x');
    expect(collect(stdout).getAssistantErrorCode()).toBe('authentication_failed');
  });

  it.each([137, 130, 143])('exit %i still returns the stopped sentence', async (code) => {
    const { message } = await run(recording('claude-no-login'), code, 'claude-code');
    expect(message).toBe('CLI process was stopped before it finished (cancelled or timed out).');
  });

  it.each(['rate_limit', 'server_error'])('the %s code is not read as auth', async (code) => {
    const { outcome, message } = await run(
      init + assistant('x', { error: code }) + failedResult('x'),
      1,
      'claude-code',
    );
    expect(outcome.streamFailureClass).toBe(code);
    expect(fatalClassFromMessage(message)).not.toBe('auth');
  });
});
