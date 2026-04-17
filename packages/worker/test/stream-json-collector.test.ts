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
