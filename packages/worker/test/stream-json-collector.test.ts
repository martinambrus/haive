import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec-queue.js';
import {
  classifyStreamFailure,
  isOutputTruncationMessage,
  OUTPUT_TRUNCATION_HEADLINE,
  isTransientCliFailure,
  classifyProviderFatal,
} from '../src/queues/cli-exec/failure-class.js';

function feed(collector: ReturnType<typeof createStreamJsonCollector>, events: unknown[]): void {
  for (const e of events) collector.onChunk(JSON.stringify(e) + '\n');
}

describe('createStreamJsonCollector.getNoResultReason', () => {
  it('returns null when a success result event was seen', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: '{"answer":1}' },
    ]);
    expect(c.getResult()).toBe('{"answer":1}');
    expect(c.getNoResultReason()).toBeNull();
  });

  it('returns null when no stream-json events were seen at all (plain-JSON path)', () => {
    const c = createStreamJsonCollector();
    c.onChunk('just plain text output, no newline-delimited JSON');
    expect(c.isStreamJson()).toBe(false);
    expect(c.getNoResultReason()).toBeNull();
  });

  it('flags init-only streams as a premature-end failure', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          isUsingOverage: false,
        },
      },
    ]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/no result event|stream ended prematurely/i);
  });

  it('flags a result event with a non-success subtype', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'error_max_turns' },
    ]);
    expect(c.getNoResultReason()).toMatch(/error_max_turns/);
  });

  it("surfaces the result event's error text alongside the subtype (e.g. amp credits)", () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'Execute mode (amp -x) and the Amp SDK require paid credits.',
      },
    ]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/error_during_execution/);
    expect(reason).toMatch(/require paid credits/);
  });

  it('classifies a max_tokens result as output truncation with an actionable message', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, error: 'max_tokens' },
    ]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/output truncated/i);
    expect(reason).toMatch(/output-token limit/i);
    expect(reason).toMatch(/split the task|reduce the requested output/i);
    expect(isOutputTruncationMessage(reason)).toBe(true);
  });

  it('classifies a context-window overflow distinctly from output truncation', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'Prompt is too long: 250000 tokens > 200000 maximum',
      },
    ]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/context window/i);
    expect(reason).not.toMatch(/output truncated/i);
    expect(isOutputTruncationMessage(reason)).toBe(false);
  });

  it('flags an overage-rejected rate-limit event while the user is already in overage', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          isUsingOverage: true,
        },
      },
    ]);
    expect(c.getNoResultReason()).toMatch(/rate limit/i);
    expect(c.getNoResultReason()).toMatch(/out_of_credits/);
  });
});

describe('classifyStreamFailure', () => {
  it('flags max_tokens / MAX_TOKENS / max_output_tokens as output_truncated', () => {
    expect(classifyStreamFailure('error_during_execution', 'max_tokens')).toBe('output_truncated');
    expect(classifyStreamFailure('error', 'finishReason: MAX_TOKENS')).toBe('output_truncated');
    expect(classifyStreamFailure(null, 'max_output_tokens reached')).toBe('output_truncated');
  });

  it('flags prompt / context-window overflow as context_overflow', () => {
    expect(classifyStreamFailure('error_during_execution', 'Prompt is too long')).toBe(
      'context_overflow',
    );
    expect(classifyStreamFailure('error', 'context_length_exceeded')).toBe('context_overflow');
  });

  it('leaves unrelated failures generic', () => {
    expect(classifyStreamFailure('error_max_turns', null)).toBe('generic');
    expect(classifyStreamFailure('error_during_execution', 'require paid credits')).toBe('generic');
  });

  it('isOutputTruncationMessage detects the headline produced by getNoResultReason', () => {
    expect(isOutputTruncationMessage(`${OUTPUT_TRUNCATION_HEADLINE} — foo`)).toBe(true);
    expect(isOutputTruncationMessage('cli invocation failed: something else')).toBe(false);
    expect(isOutputTruncationMessage(null)).toBe(false);
  });
});

describe('createStreamJsonCollector.getTokenUsage', () => {
  it('prefers the result event usage over assistant sums and attaches cost', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'assistant',
        message: { usage: { input_tokens: 3, output_tokens: 7 }, content: [] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        total_cost_usd: 0.12,
      },
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 5,
      outputTokens: 50,
      totalTokens: 355,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      costUsd: 0.12,
      peakPromptTokens: 3,
    });
  });

  it('sums assistant usages (amp message.usage placement) when no result usage exists', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 16256,
            cache_read_input_tokens: 0,
            output_tokens: 99,
          },
          content: [],
        },
      },
      {
        type: 'assistant',
        message: { usage: { input_tokens: 20, output_tokens: 1 }, content: [] },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 30,
      outputTokens: 100,
      totalTokens: 16386,
      cacheCreationTokens: 16256,
      peakPromptTokens: 16266,
    });
  });

  const usageOf = (i: number, o: number, r: number, w: number) => ({
    input_tokens: i,
    output_tokens: o,
    cache_read_input_tokens: r,
    cache_creation_input_tokens: w,
  });
  const blockEvent = (
    id: string,
    block: unknown,
    usage: unknown,
    parent: string | null = null,
  ) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, content: [block], usage },
  });
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
  const killedRunEvents = () => {
    const u1 = usageOf(5, 100, 1000, 400);
    const u2 = usageOf(7, 200, 1400, 300);
    const u3 = usageOf(2, 50, 1700, 100);
    return [
      blockEvent('msg_1', { type: 'thinking', thinking: 'a' }, u1),
      blockEvent('msg_1', { type: 'text', text: 'b' }, u1),
      blockEvent('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }, u1),
      toolResult,
      blockEvent('msg_2', { type: 'text', text: 'c' }, u2),
      blockEvent('msg_2', { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }, u2),
      toolResult,
      blockEvent('msg_3', { type: 'text', text: 'd' }, u3),
    ];
  };

  it('killed run: counts each message once across its several events, all four buckets summed', () => {
    const c = createStreamJsonCollector();
    feed(c, killedRunEvents());
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 14,
      outputTokens: 350,
      totalTokens: 5264,
      cacheReadTokens: 4100,
      cacheCreationTokens: 800,
      peakPromptTokens: 1802,
    });
  });

  it('live reading equals what the result then reports', () => {
    const c = createStreamJsonCollector();
    feed(c, killedRunEvents());
    const live = c.getTokenUsage();
    feed(c, [
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        usage: usageOf(14, 350, 4100, 800),
      },
    ]);
    expect(c.getTokenUsage()).toEqual(live);
  });

  it('interleaved message ids (parallel sub-agents) are each counted once', () => {
    const ua = usageOf(3, 30, 300, 30);
    const ub = usageOf(4, 40, 400, 40);
    const c = createStreamJsonCollector();
    feed(c, [
      blockEvent('msg_a', { type: 'text', text: 'a1' }, ua, 'toolu_1'),
      blockEvent('msg_b', { type: 'text', text: 'b1' }, ub, 'toolu_2'),
      blockEvent('msg_a', { type: 'text', text: 'a2' }, ua, 'toolu_1'),
      blockEvent('msg_b', { type: 'text', text: 'b2' }, ub, 'toolu_2'),
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 7,
      outputTokens: 70,
      totalTokens: 847,
      cacheReadTokens: 700,
      cacheCreationTokens: 70,
      peakPromptTokens: 444,
    });
  });

  it('sums cache_read per event when events carry no message.id (amp), like the CLI result', () => {
    // An event without an id is its own message, so each one is summed in full.
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 800,
          },
          content: [],
        },
      },
      {
        type: 'assistant',
        message: {
          usage: { input_tokens: 7, output_tokens: 20, cache_read_input_tokens: 1500 },
          content: [],
        },
      },
      {
        type: 'assistant',
        message: {
          usage: { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 1800 },
          content: [],
        },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 14,
      outputTokens: 60,
      totalTokens: 5174,
      cacheReadTokens: 4300,
      cacheCreationTokens: 800,
      peakPromptTokens: 1805,
    });
  });

  it('accepts a top-level assistant usage placement, counted once', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'assistant',
        usage: { input_tokens: 10, output_tokens: 5 },
        message: { content: [] },
      },
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      peakPromptTokens: 10,
    });
  });

  it('prefers message.usage when both placements exist on one event', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'assistant',
        usage: { input_tokens: 999, output_tokens: 999 },
        message: { usage: { input_tokens: 1, output_tokens: 2 }, content: [] },
      },
    ]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      peakPromptTokens: 1,
    });
  });

  it('captures usage from a non-success result event (tokens were still burned)', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      {
        type: 'result',
        subtype: 'error_max_turns',
        usage: { input_tokens: 40, output_tokens: 60 },
      },
    ]);
    expect(c.getTokenUsage()).toEqual({ inputTokens: 40, outputTokens: 60, totalTokens: 100 });
  });

  it('returns null when nothing reported usage', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    expect(c.getTokenUsage()).toBeNull();
    const plain = createStreamJsonCollector();
    plain.onChunk('not json at all');
    expect(plain.getTokenUsage()).toBeNull();
  });

  const peakRunEvents = () => [
    blockEvent('msg_1', { type: 'thinking', thinking: 'a' }, usageOf(10, 100, 50000, 30000)),
    blockEvent('msg_1', { type: 'text', text: 'b' }, usageOf(10, 100, 50000, 30000)),
    toolResult,
    blockEvent('msg_2', { type: 'text', text: 'c' }, usageOf(8, 200, 85000, 15000)),
    toolResult,
    blockEvent('msg_3', { type: 'text', text: 'd' }, usageOf(6, 300, 110000, 10000)),
  ];
  const peakResult = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: usageOf(24, 600, 245000, 55000),
  };

  it('records the largest single-message prompt beside the cumulative result usage', () => {
    const c = createStreamJsonCollector();
    feed(c, [...peakRunEvents(), peakResult]);
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 24,
      outputTokens: 600,
      totalTokens: 300624,
      cacheReadTokens: 245000,
      cacheCreationTokens: 55000,
      peakPromptTokens: 120006,
    });
  });

  it('records the same peak for a killed run that never produced a result', () => {
    const c = createStreamJsonCollector();
    feed(c, peakRunEvents());
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 24,
      outputTokens: 600,
      totalTokens: 300624,
      cacheReadTokens: 245000,
      cacheCreationTokens: 55000,
      peakPromptTokens: 120006,
    });
  });

  it('counts a sub-agent message toward the peak', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      ...peakRunEvents(),
      blockEvent('msg_sub', { type: 'text', text: 's' }, usageOf(4, 10, 200000, 5000), 'toolu_9'),
      peakResult,
    ]);
    expect(c.getTokenUsage()?.peakPromptTokens).toBe(205004);
  });

  const zeroUsage = { input_tokens: 0, output_tokens: 0 };
  const zeroMsg = (id: string) => blockEvent(id, { type: 'text', text: 'z' }, zeroUsage);
  const zaiResult = (extra: Record<string, unknown> = {}) => ({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 31333, cache_read_input_tokens: 768, output_tokens: 69 },
    ...extra,
  });

  it('leaves peakPromptTokens absent when several zero-usage messages share one result', () => {
    const c = createStreamJsonCollector();
    feed(c, [zeroMsg('msg_z1'), zeroMsg('msg_z2'), peakResult]);
    expect(c.getTokenUsage()).not.toHaveProperty('peakPromptTokens');
  });

  it('takes the result prompt as the peak when one zero-usage message made the whole run', () => {
    const c = createStreamJsonCollector();
    feed(c, [zeroMsg('msg_z'), zaiResult()]);
    expect(c.getTokenUsage()?.peakPromptTokens).toBe(32101);
  });

  it('leaves the peak absent for a steered run of four zero-usage messages', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      zeroMsg('msg_1'),
      zeroMsg('msg_2'),
      zaiResult({ num_turns: 2 }),
      zeroMsg('msg_3'),
      zeroMsg('msg_4'),
      zaiResult({ num_turns: 1 }),
    ]);
    expect(c.getTokenUsage()).not.toHaveProperty('peakPromptTokens');
  });

  it('keeps the message prompt as the peak when the one message carries usage', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      blockEvent('msg_u', { type: 'text', text: 'u' }, usageOf(10, 5, 5000, 0)),
      zaiResult({ usage: usageOf(900, 50, 90000, 0) }),
    ]);
    expect(c.getTokenUsage()?.peakPromptTokens).toBe(5010);
  });

  it('leaves the peak absent for one zero-usage message and no result', () => {
    const c = createStreamJsonCollector();
    feed(c, [zeroMsg('msg_z')]);
    expect(c.getTokenUsage()).not.toHaveProperty('peakPromptTokens');
  });

  it('leaves the peak absent when the result prompt is 0', () => {
    const c = createStreamJsonCollector();
    feed(c, [zeroMsg('msg_z'), zaiResult({ usage: { input_tokens: 0, output_tokens: 7 } })]);
    expect(c.getTokenUsage()).not.toHaveProperty('peakPromptTokens');
  });
});

describe('createStreamJsonCollector onText (Clean-tab prose stream)', () => {
  it('fires onText with each assistant text block, excluding tool_use', () => {
    const prose: string[] = [];
    const c = createStreamJsonCollector(undefined, (t) => prose.push(t));
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
            { type: 'text', text: 'world' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'Hello world' },
    ]);
    c.getResult();
    expect(prose).toEqual(['Hello ', 'world']);
    // The streamed prose must reconstruct the same text the collector accumulated.
    expect(prose.join('')).toBe(c.getAssistantText());
  });

  it('emits nothing for a tool_use-only assistant event', () => {
    const prose: string[] = [];
    const c = createStreamJsonCollector(undefined, (t) => prose.push(t));
    feed(c, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      },
    ]);
    expect(prose).toEqual([]);
  });
});

describe('createStreamJsonCollector.getModelIdentity', () => {
  // Fixtures below are the shapes MEASURED off live CLIs on 2026-08-18 via
  // test/model-report-discover.ts, not invented ones.

  it('separates what zai ASKED for from what it was SERVED', () => {
    // The measured swap: the provider is configured for glm-5.2[1m] and api.z.ai
    // answered as glm-5.3. Collapsing these into one field would hide it entirely.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', model: 'glm-5.2[1m]', session_id: 'a' },
      { type: 'assistant', message: { model: 'glm-5.3', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success', result: 'ok', modelUsage: { 'glm-5.2[1m]': {} } },
    ]);
    expect(c.getModelIdentity()).toEqual({
      requested: 'glm-5.2[1m]',
      served: 'glm-5.3',
      billed: ['glm-5.2[1m]'],
    });
  });

  it('ignores the <synthetic> assistant the CLI authors for its own errors', () => {
    // Measured on an OpenRouter 402: the last assistant event is CLI-generated with
    // model "<synthetic>". Taking it would report "<synthetic>" as the model served.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', model: 'deepseek/deepseek-v4-pro-0813' },
      { type: 'assistant', message: { model: 'deepseek/deepseek-v4-pro-0813', content: [] } },
      { type: 'assistant', message: { model: '<synthetic>', content: [] } },
    ]);
    expect(c.getModelIdentity()?.served).toBe('deepseek/deepseek-v4-pro-0813');
  });

  it('reports served null when every assistant turn was synthetic', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', model: 'qwen/qwen3.8-27b' },
      { type: 'assistant', message: { model: '<synthetic>', content: [] } },
    ]);
    expect(c.getModelIdentity()).toEqual({
      requested: 'qwen/qwen3.8-27b',
      served: null,
      billed: [],
    });
  });

  it('keeps claude-code’s billed side model out of served', () => {
    // claude-code bills a haiku call for session titling; it is not what answered.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [] } },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-sonnet-4-6': {} },
      },
    ]);
    const id = c.getModelIdentity()!;
    expect(id.served).toBe('claude-sonnet-4-6');
    expect(id.billed).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
  });

  it('does not let grok’s billing alias become the served model', () => {
    // Measured: grok serves `grok-4.6` but bills usage under `grok-4.6-build`.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', model: 'grok-4.6' },
      { type: 'assistant', message: { model: 'grok-4.6', content: [] } },
      { type: 'result', subtype: 'success', result: 'ok', modelUsage: { 'grok-4.6-build': {} } },
    ]);
    const id = c.getModelIdentity()!;
    expect(id.served).toBe('grok-4.6');
    expect(id.billed).toEqual(['grok-4.6-build']);
  });

  it('still names the requested model when the run died before any turn', () => {
    // ollama timed out mid-run in the live probe: only the init event arrived.
    const c = createStreamJsonCollector();
    feed(c, [{ type: 'system', subtype: 'init', model: 'nemotron-3-ultra:cloud' }]);
    expect(c.getModelIdentity()).toEqual({
      requested: 'nemotron-3-ultra:cloud',
      served: null,
      billed: [],
    });
  });

  it('returns null for a stream that names no model (amp)', () => {
    // Measured: amp's init reports `agent_mode`, never a model.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init', agent_mode: 'medium', session_id: 'T-1' },
      { type: 'result', subtype: 'error_during_execution', error: 'Out of Credits' },
    ]);
    expect(c.getModelIdentity()).toBeNull();
  });
});

describe('createStreamJsonCollector: run-level is_error on a "success" subtype', () => {
  // Both payloads are the REAL result events from ollama.com stalling mid-response
  // on nemotron-3-ultra:cloud (invocations cdf09b04 and 0cf1adec). The binary reports
  // an aborted stream as subtype "success" with is_error true and the error text in
  // `result` — so subtype alone cannot be trusted to mean the run produced an answer.
  const STALLED_RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    result: 'API Error: The response stopped arriving. The response above may be incomplete.',
  };

  it('does NOT return the error text as the model answer', () => {
    const c = createStreamJsonCollector();
    feed(c, [{ type: 'system', subtype: 'init' }, STALLED_RESULT]);
    expect(c.getResult()).toBeNull();
    expect(c.hadResultError()).toBe(true);
  });

  it('reports the binary error text and terminal_reason as the failure reason', () => {
    const c = createStreamJsonCollector();
    feed(c, [{ type: 'system', subtype: 'init' }, STALLED_RESULT]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/response stopped arriving/);
    expect(reason).toMatch(/api_error/);
  });

  it('avoids the transient "stream ended prematurely" wording that triggers re-dispatch', () => {
    // TRANSIENT_CLI_FAILURE_RE means "killed before it got its chance", which would
    // re-dispatch. A provider error got its chance and failed, so it must not match.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { ...STALLED_RESULT, result: 'API Error: The operation timed out.' },
    ]);
    const reason = c.getNoResultReason()!;
    expect(isTransientCliFailure({ exitCode: 1, errorMessage: reason })).toBe(false);
  });

  it('still treats a genuine success (is_error false) as a result', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false, result: '{"answer":1}' },
    ]);
    expect(c.getResult()).toBe('{"answer":1}');
    expect(c.hadResultError()).toBe(false);
    expect(c.getNoResultReason()).toBeNull();
  });

  it('ignores is_error on tool_result blocks — only the result event counts', () => {
    // A successful claude-code run legitimately carries failed tool calls; keying on
    // is_error anywhere in the stream would fail every run that had one (verified on
    // invocation f5933ed9, which succeeded with several such blocks).
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', is_error: true, content: 'file not found' }],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ]);
    expect(c.getResult()).toBe('done');
    expect(c.hadResultError()).toBe(false);
  });

  it('keeps the provider error text intact so classifyProviderFatal still matches', () => {
    // 92 historical invocations reached the correct 'rate_limit' classification only
    // because the provider's wording ("session limit") was in the haystack. The reason
    // string must carry that text verbatim or routing this event to the no-result
    // branch would silently downgrade them to unclassified failures.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: "You've hit your session limit · resets 7:30pm (UTC)",
      },
    ]);
    const reason = c.getNoResultReason();
    expect(reason).toContain("You've hit your session limit");
    expect(classifyProviderFatal(1, reason, c.getAssistantText())).toBe('rate_limit');
  });
});

describe('createStreamJsonCollector: structured rate-limit rejection', () => {
  // The real rate_limit_info from invocation 065ce2d0 (claude-code). Note
  // isUsingOverage:false — the old guard required it true, so this never matched and
  // fell through to the provider's prose, where "You've hit your limit" (no "session")
  // matches no RATE_LIMIT_RE alternative. 22 live invocations were unclassified.
  const REJECTED = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1786046400,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
  };
  const LIMIT_RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    result: "You've hit your limit · resets 2:50pm (UTC)",
  };

  it('classifies as rate_limit despite isUsingOverage being false', () => {
    const c = createStreamJsonCollector();
    feed(c, [{ type: 'system', subtype: 'init' }, REJECTED, LIMIT_RESULT]);
    const reason = c.getNoResultReason();
    expect(reason).toMatch(/rate limit/i);
    expect(reason).toMatch(/five_hour/);
    expect(classifyProviderFatal(1, reason, c.getAssistantText())).toBe('rate_limit');
  });

  it('wins over the generic is_error report, which would not classify', () => {
    // Ordering is the whole fix: the is_error branch would return "LLM run reported a
    // failure ...: You've hit your limit", which carries no token RATE_LIMIT_RE matches.
    const c = createStreamJsonCollector();
    feed(c, [{ type: 'system', subtype: 'init' }, REJECTED, LIMIT_RESULT]);
    expect(c.getNoResultReason()).not.toMatch(/LLM run reported a failure/);
  });

  it('leaves a non-rejected rate_limit_event alone', () => {
    // An "allowed" status is a routine usage heartbeat, not a refusal.
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } },
      LIMIT_RESULT,
    ]);
    expect(c.getNoResultReason()).toMatch(/LLM run reported a failure/);
  });

  it('still honours the legacy overage-rejected shape', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      { type: 'system', subtype: 'init' },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          overageStatus: 'rejected',
          overageDisabledReason: 'org_level_disabled',
          isUsingOverage: true,
        },
      },
    ]);
    expect(c.getNoResultReason()).toMatch(/rate limit/i);
  });
});

describe('createStreamJsonCollector.getToolUsage', () => {
  // Block shapes MEASURED on stored claude-code 2.1.270 rows; see test/tool-usage.test.ts for
  // the tally itself. These pin the collector's WIRING: what feeds it, and when it flushes.
  const init = {
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5',
    tools: ['Bash', 'Read', 'mcp__haive-rag__rag_search'],
    mcp_servers: [{ name: 'haive-rag', status: 'connected' }],
    agents: ['peer-reviewer', 'claude'],
    skills: ['project-context'],
  };
  const toolUse = (name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
    },
  });

  it('tallies tool_use blocks with NO progress callback (sub-agent and recap runs have none)', () => {
    const c = createStreamJsonCollector();
    feed(c, [
      init,
      toolUse('Bash', { command: 'cat .claude/skills/project-context/SKILL.md' }),
      toolUse('Read', { file_path: '/haive/workdir/web/index.php' }),
      toolUse('mcp__haive-rag__rag_search', { query: 'signing' }),
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    const usage = c.getToolUsage();
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({ Bash: 1, Read: 1 });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'project-context', reads: 1 }]);
    expect(usage.loaded).toEqual({
      agents: ['claude', 'peer-reviewer'],
      skills: ['project-context'],
      mcpServers: ['haive-rag'],
      toolCount: 3,
    });
  });

  it('still renders the progress line when a callback is present', () => {
    const lines: string[] = [];
    const c = createStreamJsonCollector((m) => lines.push(m));
    feed(c, [toolUse('Bash', { command: 'ls -la' })]);
    expect(lines).toEqual(['Running: ls -la']);
    expect(c.getToolUsage().tools).toEqual({ Bash: 1 });
  });

  it('flushes a partial last line before answering, like the other accessors', () => {
    const c = createStreamJsonCollector();
    c.onChunk(JSON.stringify(toolUse('Read', { file_path: '.claude/agents/peer-reviewer.md' })));
    expect(c.getToolUsage().agents.read).toEqual([{ id: 'peer-reviewer', reads: 1 }]);
  });

  it('keeps the first init event, as getModelIdentity does', () => {
    const c = createStreamJsonCollector();
    feed(c, [init, { ...init, agents: ['other'] }]);
    expect(c.getToolUsage().loaded?.agents).toEqual(['claude', 'peer-reviewer']);
  });

  it('reports plain output as not observable', () => {
    const c = createStreamJsonCollector();
    c.onChunk('just plain text output, no newline-delimited JSON');
    expect(c.getToolUsage().coverage).toBe('none');
  });
});

describe('createStreamJsonCollector contextWindow', () => {
  const asst = (
    id: string,
    model: string,
    usage: Record<string, number> = { input_tokens: 100 },
  ) => ({
    type: 'assistant',
    message: {
      id,
      model,
      content: [{ type: 'text', text: 'x' }],
      usage: { output_tokens: 1, ...usage },
    },
  });
  const res = (modelUsage?: unknown) => ({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 1 },
    ...(modelUsage === undefined ? {} : { modelUsage }),
  });
  const win = (contextWindow: unknown) => ({ contextWindow, inputTokens: 1, outputTokens: 1 });
  const windowOf = (events: unknown[]) => {
    const c = createStreamJsonCollector();
    feed(c, events);
    return c.getTokenUsage();
  };

  it('takes the window of the model the init event named, not the first listed entry', () => {
    const usage = windowOf([
      { type: 'system', subtype: 'init', model: 'claude-opus-5[1m]' },
      asst('m1', 'claude-opus-5[1m]'),
      res({
        'claude-haiku-4-5': win(200000),
        'claude-opus-5[1m]': win(1000000),
      }),
    ]);
    expect(usage).toHaveProperty('contextWindow', 1000000);
  });

  it('reads the zai shape: init glm-5.3[1m], served glm-5.3, two keys', () => {
    const usage = windowOf([
      { type: 'system', subtype: 'init', model: 'glm-5.3[1m]' },
      asst('m1', 'glm-5.3'),
      res({ 'glm-4.5-air': win(200000), 'glm-5.3[1m]': win(1000000) }),
    ]);
    expect(usage).toHaveProperty('contextWindow', 1000000);
  });

  it('falls back to the served model when init names none or names a model no key matches', () => {
    const entries = { 'claude-haiku-4-5': win(200000), 'served-model': win(777000) };
    expect(
      windowOf([{ type: 'system', subtype: 'init' }, asst('m1', 'served-model'), res(entries)]),
    ).toHaveProperty('contextWindow', 777000);
    expect(
      windowOf([
        { type: 'system', subtype: 'init', model: 'unlisted-model' },
        asst('m1', 'served-model'),
        res(entries),
      ]),
    ).toHaveProperty('contextWindow', 777000);
  });

  it('leaves the property absent when no entry can be attributed to the run', () => {
    const init = { type: 'system', subtype: 'init', model: 'main-model' };
    expect(windowOf([init, asst('m1', 'main-model'), res({})])).not.toHaveProperty('contextWindow');
    expect(windowOf([init, asst('m1', 'main-model'), res()])).not.toHaveProperty('contextWindow');
    expect(
      windowOf([
        init,
        asst('m1', 'main-model'),
        res({ 'main-model': { inputTokens: 1, outputTokens: 1 } }),
      ]),
    ).not.toHaveProperty('contextWindow');
    expect(
      windowOf([init, asst('m1', 'main-model'), res({ 'claude-haiku-4-5': win(200000) })]),
    ).not.toHaveProperty('contextWindow');
  });

  it('ignores a window that is not a finite number above zero', () => {
    for (const bad of [0, -5, '1000000', null]) {
      const usage = windowOf([
        { type: 'system', subtype: 'init', model: 'main-model' },
        asst('m1', 'main-model'),
        res({ 'main-model': win(bad) }),
      ]);
      expect(usage, JSON.stringify(bad)).not.toHaveProperty('contextWindow');
    }
  });

  it('keeps the window across a later result that carries none, and takes a later one', () => {
    const init = { type: 'system', subtype: 'init', model: 'main-model' };
    const windowed = res({ 'main-model': win(1000000) });
    expect(windowOf([init, asst('m1', 'main-model'), windowed, res({})])).toHaveProperty(
      'contextWindow',
      1000000,
    );
    expect(windowOf([init, asst('m1', 'main-model'), res({}), windowed])).toHaveProperty(
      'contextWindow',
      1000000,
    );
  });

  it('reports the peak but no window for a killed run with no result event', () => {
    const usage = windowOf([
      { type: 'system', subtype: 'init', model: 'main-model' },
      asst('m1', 'main-model', { input_tokens: 10, cache_read_input_tokens: 5000 }),
      asst('m2', 'main-model', { input_tokens: 20, cache_read_input_tokens: 9000 }),
    ]);
    expect(usage).toHaveProperty('peakPromptTokens', 9020);
    expect(usage).not.toHaveProperty('contextWindow');
  });

  it('reports the window even when no assistant message carried usage', () => {
    const zero = { input_tokens: 0, output_tokens: 0 };
    const usage = windowOf([
      { type: 'system', subtype: 'init', model: 'main-model' },
      asst('m1', 'main-model', zero),
      asst('m2', 'main-model', zero),
      res({ 'main-model': win(1000000) }),
    ]);
    expect(usage).toHaveProperty('contextWindow', 1000000);
    expect(usage).not.toHaveProperty('peakPromptTokens');
  });
});
