import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

/** Trimmed from a stored claude-code (claude-opus-5-5) transcript on the dev install; the key
 *  order is the binary's own, with `type` after `duration_api_ms`. */
const LIVE_RESULT = {
  duration_api_ms: 2275,
  stop_reason: 'end_turn',
  session_id: '60813885-2811-4306-b728-db1f03c37cff',
  total_cost_usd: 0.0246938,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 2647,
    cache_read_input_tokens: 2049,
    output_tokens: 155,
  },
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 3001,
  result: 'ok',
};

describe('api duration', () => {
  it('reads duration_api_ms off a live result event', () => {
    const c = createStreamJsonCollector();
    c.onChunk(line(LIVE_RESULT));
    expect(c.getApiDurationMs()).toBe(2275);
  });

  it('keeps the LAST result of a steered run, since the value is cumulative', () => {
    const c = createStreamJsonCollector();
    c.onChunk(line({ ...LIVE_RESULT, duration_api_ms: 27_366 }));
    c.onChunk(line({ ...LIVE_RESULT, duration_api_ms: 35_255 }));
    expect(c.getApiDurationMs()).toBe(35_255);
  });

  it('is null when no result event arrived', () => {
    const c = createStreamJsonCollector();
    c.onChunk(line({ type: 'assistant', message: { content: [], usage: { output_tokens: 3 } } }));
    expect(c.getApiDurationMs()).toBeNull();
  });

  it('ignores a non-numeric value rather than recording it', () => {
    const c = createStreamJsonCollector();
    c.onChunk(line({ ...LIVE_RESULT, duration_api_ms: '2275' }));
    expect(c.getApiDurationMs()).toBeNull();
  });

  it('reads a final event still sitting unterminated in the buffer', () => {
    const c = createStreamJsonCollector();
    c.onChunk(JSON.stringify(LIVE_RESULT));
    expect(c.getApiDurationMs()).toBe(2275);
  });

  it('is recorded on an error result too, since that run still used model time', () => {
    const c = createStreamJsonCollector();
    c.onChunk(line({ ...LIVE_RESULT, subtype: 'error_max_turns', is_error: true }));
    expect(c.getApiDurationMs()).toBe(2275);
  });
});
