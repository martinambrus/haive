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
  capabilityClassFromMessage,
  fatalClassFromMessage,
  fatalClassFromStreamErrorCode,
  type ProviderFatalClass,
} from '../src/queues/cli-exec/failure-class.js';

/** The claude binary stamps a top-level `error` code on the assistant event it authors for an API
 *  failure. These controls derive every stream from the no-login recording, changing only that
 *  code and the text, so the code is the one thing that differs between a run and its control. */
const RECORDING = readFileSync(
  new URL('./fixtures/streams/claude-no-login.jsonl', import.meta.url),
  'utf8',
);

const NEUTRAL = 'The request could not be completed.';
const OUTPUT_CAP_TEXT =
  "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";

/** The recording with the assistant event's `error` code and text block, and the result event's
 *  text, replaced. Nothing else changes. */
function withCode(code: string, text: string): string {
  return RECORDING.split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const event = JSON.parse(l) as Record<string, any>;
      if (event.type === 'assistant') {
        event.error = code;
        event.message.content = [{ type: 'text', text }];
      } else if (event.type === 'result') {
        event.result = text;
      }
      return JSON.stringify(event) + '\n';
    })
    .join('');
}

/** The assistant and result lines of withCode, without the init event. */
const turnOf = (code: string, text: string) => withCode(code, text).split('\n').slice(1).join('\n');
const initLine = RECORDING.split('\n')[0]! + '\n';

const line = (event: unknown) => JSON.stringify(event) + '\n';
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

async function run(stdout: string, exitCode: number, provider = 'claude-code') {
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

type Case = readonly [code: string, cls: ProviderFatalClass, text: string];
const CASES: readonly Case[] = [
  [
    'oauth_org_not_allowed',
    'auth',
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
  ],
  [
    'account_on_hold',
    'auth',
    "Your account is on hold and can't sign in to Claude Code. View details or appeal: https://example.invalid/appeal",
  ],
  [
    'verification_required',
    'auth',
    'API Error: Additional account verification is required to continue.',
  ],
  ['billing_error', 'rate_limit', 'Credit balance is too low'],
  [
    'rate_limit',
    'rate_limit',
    'API Error: Server is temporarily limiting requests (not your usage limit)',
  ],
  ['overloaded', 'server_error', 'API Error: Repeated 529 Overloaded errors'],
  [
    'server_error',
    'server_error',
    'API Error: Repeated 529 Overloaded errors. The API is at capacity',
  ],
];
/** Each case against its own CLI text and against wording no text rule matches. */
const TEXTED = CASES.flatMap(([code, cls, text]) => [
  [code, cls, text],
  [code, cls, NEUTRAL],
]) as unknown as Case[];

const UNMAPPED = [
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'unknown',
  'cloud_credential_error',
];

describe('fatalClassFromStreamErrorCode', () => {
  it.each([['authentication_failed', 'auth'] as const, ...CASES.map(([c, k]) => [c, k] as const)])(
    '%s names the %s class',
    (code, cls) => {
      expect(fatalClassFromStreamErrorCode(code)).toBe(cls);
    },
  );

  it.each([
    ...UNMAPPED,
    '',
    ' rate_limit',
    'rate_limit ',
    'RATE_LIMIT',
    'constructor',
    '__proto__',
    'toString',
    null,
    undefined,
  ])('names no class for %j', (code) => {
    expect(fatalClassFromStreamErrorCode(code)).toBeNull();
  });
});

describe('the collector reads the last top-level assistant error code', () => {
  const sub = { parent_tool_use_id: 'toolu_sub' };

  it('returns the code of the last top-level assistant event', () => {
    const c = collect(assistant('a', { error: 'overloaded' }) + assistant('b', { error: 'x' }));
    expect(c.getAssistantErrorCode()).toBe('x');
  });

  it('returns null when no assistant event carries one', () => {
    expect(collect(assistant('a')).getAssistantErrorCode()).toBeNull();
    expect(createStreamJsonCollector().getAssistantErrorCode()).toBeNull();
  });

  it('is reset by a later clean top-level assistant event', () => {
    const c = collect(assistant('a', { error: 'overloaded' }) + assistant('b'));
    expect(c.getAssistantErrorCode()).toBeNull();
  });

  it('is neither set nor cleared by a sub-agent turn', () => {
    expect(collect(assistant('a', { ...sub, error: 'overloaded' })).getAssistantErrorCode()).toBe(
      null,
    );
    const c = collect(assistant('a', { error: 'overloaded' }) + assistant('b', sub));
    expect(c.getAssistantErrorCode()).toBe('overloaded');
  });

  it('gives null for a non-string error', () => {
    expect(collect(assistant('a', { error: 7 })).getAssistantErrorCode()).toBeNull();
    expect(collect(assistant('a', { error: { code: 'x' } })).getAssistantErrorCode()).toBeNull();
  });

  it('keeps hadAuthFailure true only for authentication_failed', () => {
    expect(collect(assistant('a', { error: 'authentication_failed' })).hadAuthFailure()).toBe(true);
    expect(collect(assistant('a', { error: 'account_on_hold' })).hadAuthFailure()).toBe(false);
  });
});

function expectClass(
  outcome: { streamFailureClass?: ProviderFatalClass },
  message: string | null,
  cls: ProviderFatalClass,
) {
  expect(fatalClassFromMessage(message)).toBe(cls);
  expect(message?.startsWith(PROVIDER_FATAL_HEADLINES[cls])).toBe(true);
  expect(outcome.streamFailureClass).toBe(cls);
}

describe('a run with no result event is classified by the stream error code', () => {
  it.each(TEXTED)('%s -> %s (%s)', async (code, cls, text) => {
    const { outcome, message } = await run(withCode(code, text), 1);
    expectClass(outcome, message, cls);
    if (cls === 'auth') expect(message).toContain('claude /login');
  });

  it('a final mapped code on exit 0 is not classified', async () => {
    const { message, outcome } = await run(withCode('server_error', NEUTRAL), 0);
    expect(message).toBe(outcome.errorMessage ?? null);
    expect(fatalClassFromMessage(message)).toBeNull();
  });
});

describe('a steered run whose later turn fails is classified by the stream error code', () => {
  const steered = (later: string) =>
    initLine + assistant('first answer') + okResult('first answer') + initLine + later;

  it.each(TEXTED)('%s -> %s (%s)', async (code, cls, text) => {
    const stdout = steered(turnOf(code, text));
    expect(collect(stdout).getResult()).toBe('first answer');
    const { outcome, message } = await run(stdout, 1);
    expectClass(outcome, message, cls);
  });

  it('authentication_failed in the later turn gives auth and the auth flag', async () => {
    const { outcome, message } = await run(steered(turnOf('authentication_failed', NEUTRAL)), 1);
    expect(outcome.authFailure).toBe(true);
    expect(fatalClassFromMessage(message)).toBe('auth');
  });

  it.each([137, 130, 143])('exit %i returns the stopped sentence', async (exitCode) => {
    const { message } = await run(steered(turnOf('server_error', NEUTRAL)), exitCode);
    expect(message).toBe('CLI process was stopped before it finished (cancelled or timed out).');
  });

  it('a failing later turn on exit 0 is not classified', async () => {
    const { message, outcome } = await run(steered(turnOf('server_error', NEUTRAL)), 0);
    expect(message).toBe(outcome.errorMessage ?? null);
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('a later turn that errored and recovered is not classified', async () => {
    const stdout = steered(
      assistant('x', { error: 'server_error' }) + assistant('fine') + okResult('fine'),
    );
    const { outcome, message } = await run(stdout, 0);
    expect(outcome.authFailure).toBeUndefined();
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(message).toBe(outcome.errorMessage ?? null);
    expect(fatalClassFromMessage(message)).toBeNull();
  });
});

describe('only the last top-level assistant code counts', () => {
  it('a clean top-level turn after the code leaves the run unclassified', async () => {
    const { outcome, message } = await run(
      initLine +
        assistant('x', { error: 'server_error' }) +
        assistant('recovered') +
        failedResult('something else broke'),
      1,
    );
    expect(outcome.authFailure).toBeUndefined();
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('a sub-agent assistant carrying the code is ignored', async () => {
    const { outcome, message } = await run(
      initLine +
        assistant('main') +
        assistant('sub', { parent_tool_use_id: 'toolu_sub', error: 'server_error' }) +
        failedResult('something else broke'),
      1,
    );
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
  });

  it('a clean sub-agent turn after the main turn code does not clear it', async () => {
    const { outcome, message } = await run(
      initLine +
        assistant('x', { error: 'server_error' }) +
        assistant('sub', { parent_tool_use_id: 'toolu_sub' }) +
        failedResult('something else broke'),
      1,
    );
    expectClass(outcome, message, 'server_error');
  });
});

describe('unmapped codes keep the text classifier path', () => {
  const TEXTS = [NEUTRAL, 'API Error: 429 Too Many Requests'];
  const cases = UNMAPPED.flatMap((code) => TEXTS.map((text) => [code, text] as const));

  it.each(cases)('%s with %j matches the same text without a code', async (code, text) => {
    const coded = await run(withCode(code, text), 1);
    const bare = await run(initLine + assistant(text) + failedResult(text), 1);
    expect(coded.outcome.authFailure).toBeUndefined();
    expect(coded.outcome.streamFailureClass).toBeUndefined();
    expect(coded.message).toBe(bare.message);
    expect(fatalClassFromMessage(coded.message)).toBe(text === NEUTRAL ? null : 'rate_limit');
  });

  it('max_output_tokens still reaches its capability class by the env-var name', async () => {
    const { outcome, message } = await run(withCode('max_output_tokens', OUTPUT_CAP_TEXT), 1);
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(capabilityClassFromMessage(message)).toBe('output_cap_reached');
  });

  it('model_not_found stays unclassified', async () => {
    const text =
      "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.";
    const { outcome, message } = await run(withCode('model_not_found', text), 1);
    expect(outcome.streamFailureClass).toBeUndefined();
    expect(fatalClassFromMessage(message)).toBeNull();
    expect(capabilityClassFromMessage(message)).toBeNull();
  });
});

describe('the structural code wins over disagreeing text', () => {
  it('rate_limit with a 401 text is a rate limit', async () => {
    const text = 'Request failed: 401 Unauthorized';
    const { outcome, message } = await run(withCode('rate_limit', text), 1);
    expectClass(outcome, message, 'rate_limit');
  });

  it('server_error with a rate-limit text is a server error', async () => {
    const { outcome, message } = await run(
      withCode('server_error', 'API Error: 429 Too Many Requests'),
      1,
    );
    expectClass(outcome, message, 'server_error');
  });
});

describe('the capability class is read before the stream code', () => {
  it('a mapped code with the output-cap text is the capability class, not the fatal one', async () => {
    const { outcome, message } = await run(withCode('server_error', OUTPUT_CAP_TEXT), 1);
    expect(outcome.streamFailureClass).toBe('server_error');
    expect(capabilityClassFromMessage(message)).toBe('output_cap_reached');
    expect(fatalClassFromMessage(message)).toBeNull();
  });
});
