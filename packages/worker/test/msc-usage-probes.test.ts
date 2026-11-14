import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
});
const assistant = (id: string, model: string, input: number, output: number) => ({
  type: 'assistant',
  message: {
    id,
    model,
    content: [{ type: 'text', text: 'reply' }],
    usage: usage(input, output),
  },
});
const result = (input: number, output: number, cost: number) => ({
  type: 'result',
  subtype: 'success',
  result: 'reply',
  usage: usage(input, output),
  total_cost_usd: cost,
});

describe('stream usage fallback', () => {
  it('sums the per-turn usage of each result in a steered run', () => {
    // Measured 2026-11-14, claude-code 2.1.323 with a second stream-json user message sent
    // after the first result: each result's `usage` covers its own turn (1472/48, then
    // 1501/150), while `total_cost_usd`, `duration_api_ms` and `modelUsage` are cumulative
    // (the second result's modelUsage was 2973/198). Keeping only the last usage stored the
    // final turn's tokens next to the whole run's cost.
    // A steer written mid-turn, as the forwarder sends it, measured the same way (1472/934
    // then 1493/1544; modelUsage 2965/2478).
    const collector = createStreamJsonCollector();
    const events = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      assistant('first', 'claude-sonnet-5', 1583, 0),
      result(1472, 48, 0.006848),
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      assistant('second', 'claude-sonnet-5', 1650, 0),
      result(1501, 150, 0.015852),
    ];
    for (const event of events) collector.onChunk(JSON.stringify(event) + '\n');
    expect(collector.getTokenUsage()).toEqual({
      inputTokens: 2973,
      outputTokens: 198,
      totalTokens: 3171,
      costUsd: 0.015852,
      peakPromptTokens: 1650,
    });
  });

  for (const model of ['glm-5.3', 'muse-spark-1.3-contributor']) {
    it(
      'keeps usage unknown for a killed ' + model + ' run whose assistant events report zero',
      () => {
        // Supported producer: zai/muse run the Claude binary and emit zero-valued
        // assistant usage (cli-adapters.md). Killing after this message and before
        // the result leaves exactly this prefix for the existing fallback to read.
        const collector = createStreamJsonCollector();
        collector.onChunk(JSON.stringify({ type: 'system', subtype: 'init', model }) + '\n');
        collector.onChunk(JSON.stringify(assistant('billed-message', model, 0, 0)) + '\n');
        expect(collector.getNoResultReason()).toContain('no result event');
        expect(collector.getTokenUsage()).toBeNull();
      },
    );
  }
});

describe('fallback authority', () => {
  it('preserves an authoritative result with measured zero usage', () => {
    const collector = createStreamJsonCollector();
    collector.onChunk(JSON.stringify(assistant('message', 'glm-5.3', 10, 2)) + '\n');
    collector.onChunk(JSON.stringify(result(0, 0, 0)) + '\n');
    expect(collector.getTokenUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      peakPromptTokens: 10,
    });
  });

  it.each([
    { input_tokens: 1, output_tokens: 0 },
    { input_tokens: 0, output_tokens: 1 },
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 },
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1 },
  ])('keeps a nonzero assistant fallback: %j', (usage) => {
    const collector = createStreamJsonCollector();
    const event = assistant('message', 'model', 0, 0);
    event.message.usage = usage;
    collector.onChunk(JSON.stringify(event) + '\n');
    expect(collector.getTokenUsage()?.totalTokens).toBe(1);
  });
});
