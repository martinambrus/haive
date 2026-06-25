import { describe, expect, it, vi } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

describe('createStreamJsonCollector onResult hook', () => {
  it('fires once on a success result; getResult still returns the text', () => {
    const onResult = vi.fn();
    const c = createStreamJsonCollector(undefined, undefined, onResult);
    c.onChunk(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    expect(onResult).not.toHaveBeenCalled();
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'final answer' }));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(c.getResult()).toBe('final answer');
  });

  it('fires once on a non-success (error_max_turns) result too (Hole B)', () => {
    const onResult = vi.fn();
    const c = createStreamJsonCollector(undefined, undefined, onResult);
    c.onChunk(line({ type: 'result', subtype: 'error_max_turns' }));
    expect(onResult).toHaveBeenCalledTimes(1);
    // no success subtype → no result text, but the hook still fired so the
    // forwarder can close stdin instead of hanging.
    expect(c.getResult()).toBeNull();
  });

  it('back-compat: no callback passed, result still parses without throwing', () => {
    const c = createStreamJsonCollector();
    expect(() =>
      c.onChunk(line({ type: 'result', subtype: 'success', result: 'x' })),
    ).not.toThrow();
    expect(c.getResult()).toBe('x');
  });

  it('fires at most once even across two result events', () => {
    const onResult = vi.fn();
    const c = createStreamJsonCollector(undefined, undefined, onResult);
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'a' }));
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'b' }));
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
