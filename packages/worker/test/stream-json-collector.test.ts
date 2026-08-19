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
    });
  });

  it('does not inflate live cache_read across turns (max, not sum); cache_creation sums', () => {
    // Each Anthropic assistant turn re-reports the FULL cached prefix it read, so
    // summing cache_read per turn over-counts several-fold on the live snapshot
    // (1000+1500+1800=4300) before the result event reconciles it. cache_read must
    // be the running MAX (1800); cache_creation is a distinct per-turn write (summed).
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
      totalTokens: 14 + 60 + 1800 + 800,
      cacheReadTokens: 1800,
      cacheCreationTokens: 800,
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
    expect(c.getTokenUsage()).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
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
    expect(c.getTokenUsage()).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
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
