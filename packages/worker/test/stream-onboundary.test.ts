import { describe, expect, it, vi } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

// onBoundary marks a tool-call boundary (a `user` event carrying a tool_result),
// which is where Claude drains stdin-queued steer messages. See stream.ts.
describe('createStreamJsonCollector onBoundary hook', () => {
  const make = (onBoundary: () => void) =>
    createStreamJsonCollector(undefined, undefined, undefined, onBoundary);

  it('fires on a user event that carries a tool_result block', () => {
    const onBoundary = vi.fn();
    const c = make(onBoundary);
    c.onChunk(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      }),
    );
    expect(onBoundary).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on a text-only user event (a verbatim steer echo is not a boundary)', () => {
    const onBoundary = vi.fn();
    const c = make(onBoundary);
    c.onChunk(
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'focus on perf' }] },
      }),
    );
    expect(onBoundary).not.toHaveBeenCalled();
  });

  it('does NOT fire on assistant or result events', () => {
    const onBoundary = vi.fn();
    const c = make(onBoundary);
    c.onChunk(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'done' }));
    expect(onBoundary).not.toHaveBeenCalled();
  });

  it('fires once per tool_result user event (two boundaries -> two calls)', () => {
    const onBoundary = vi.fn();
    const c = make(onBoundary);
    const boundary = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
    });
    c.onChunk(boundary);
    c.onChunk(boundary);
    expect(onBoundary).toHaveBeenCalledTimes(2);
  });

  it('back-compat: no callback passed, a tool_result user event parses without throwing', () => {
    const c = createStreamJsonCollector();
    expect(() =>
      c.onChunk(
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
          },
        }),
      ),
    ).not.toThrow();
  });
});
