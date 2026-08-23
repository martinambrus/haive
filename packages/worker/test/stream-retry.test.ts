import { describe, expect, it, vi } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

// The measured shape, verbatim from a recorded stream (session/uuid trimmed).
const retryLine = (over: Record<string, unknown> = {}) =>
  line({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 615,
    error_status: null,
    error: 'unknown',
    ...over,
  });

const assistantLine = line({
  type: 'assistant',
  message: { model: 'claude-opus-4-6', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
});

// onRetry / onRetryResolved drive the viewer's stream-health badge: the CLI is backing off, and
// then it is talking again. There is no "recovered" event to key on, so ANY other event resolves.
describe('createStreamJsonCollector retry hooks', () => {
  const make = (onRetry: (i: unknown) => void, onRetryResolved: () => void) =>
    createStreamJsonCollector(undefined, undefined, undefined, undefined, onRetry, onRetryResolved);

  it('reports each retry with the event fields verbatim', () => {
    const onRetry = vi.fn();
    const c = make(onRetry, vi.fn());
    c.onChunk(retryLine({ attempt: 3, error_status: 429, error: 'rate_limit' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 3,
      maxRetries: 10,
      errorStatus: 429,
      error: 'rate_limit',
    });
  });

  it('keeps a null status null — no HTTP response arrived is the transport signal', () => {
    const onRetry = vi.fn();
    const c = make(onRetry, vi.fn());
    c.onChunk(retryLine());
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ errorStatus: null, error: 'unknown' });
  });

  it('does not resolve between consecutive retries', () => {
    const onRetry = vi.fn();
    const onResolved = vi.fn();
    const c = make(onRetry, onResolved);
    c.onChunk(retryLine({ attempt: 1 }));
    c.onChunk(retryLine({ attempt: 2 }));
    c.onChunk(retryLine({ attempt: 3 }));
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('resolves once on the next event of any other kind', () => {
    const onResolved = vi.fn();
    const c = make(vi.fn(), onResolved);
    c.onChunk(retryLine());
    c.onChunk(assistantLine);
    c.onChunk(assistantLine);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('treats a thinking_tokens system event as the CLI talking again', () => {
    const onResolved = vi.fn();
    const c = make(vi.fn(), onResolved);
    c.onChunk(retryLine());
    c.onChunk(line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 663 }));
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('never resolves without a retry outstanding', () => {
    const onResolved = vi.fn();
    const c = make(vi.fn(), onResolved);
    c.onChunk(assistantLine);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('parses a retry line split across two chunks exactly once', () => {
    const onRetry = vi.fn();
    const c = make(onRetry, vi.fn());
    const whole = retryLine({ attempt: 7 });
    const cut = Math.floor(whole.length / 2);
    c.onChunk(whole.slice(0, cut));
    c.onChunk(whole.slice(cut));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 7 });
  });

  it('still leaves the result and prose channels intact around a retry', () => {
    const onText = vi.fn();
    const c = createStreamJsonCollector(undefined, onText, undefined, undefined, vi.fn(), vi.fn());
    c.onChunk(retryLine());
    c.onChunk(assistantLine);
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'done' }));
    expect(onText).toHaveBeenCalledWith('hi');
    expect(c.getResult()).toBe('done');
  });
});
