import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeUserSockets, trackUserUpgrade } from '../src/lib/user-sockets.js';

const streams = new Set<PassThrough>();
function tracked(userId: string) {
  const stream = new PassThrough();
  streams.add(stream);
  const session = trackUserUpgrade(userId, stream);
  const ws = { close: vi.fn(), removeAllListeners: vi.fn(), on: vi.fn() };
  expect(session.accept(ws as unknown as WebSocket)).toBe(true);
  return { stream, session, ws };
}
afterEach(() => {
  for (const stream of streams) stream.destroy();
  streams.clear();
  vi.useRealTimers();
});

describe('live session registry', () => {
  it('removes a closed transport, leaves another user alone and tolerates repeated revocation', () => {
    const closed = tracked('a');
    const live = tracked('a');
    const other = tracked('b');
    closed.stream.emit('close');
    expect(closeUserSockets('a')).toBe(1);
    expect(closeUserSockets('a')).toBe(0);
    expect(closed.ws.close).not.toHaveBeenCalled();
    expect(other.ws.close).not.toHaveBeenCalled();
    expect(live.ws.close).toHaveBeenCalledTimes(1);
    expect(live.ws.close.mock.calls[0]?.[0]).toBe(1008);
    expect(live.ws.removeAllListeners).toHaveBeenCalledExactlyOnceWith('message');
  });

  it('forces teardown when a peer never acknowledges the close', () => {
    vi.useFakeTimers();
    const { stream } = tracked('d');
    closeUserSockets('d');
    expect(stream.destroyed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(stream.destroyed).toBe(true);
  });
});

it('does not register an already destroyed upgrade transport', () => {
  const stream = new PassThrough();
  stream.destroy();
  stream.emit('close');
  const session = trackUserUpgrade('destroyed', stream);
  expect(session.accept({} as WebSocket)).toBe(false);
  expect(stream.listenerCount('close')).toBe(0);
  expect(closeUserSockets('destroyed')).toBe(0);
});
