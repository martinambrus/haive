import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec-queue.js';

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
