import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeUserSockets, trackUserUpgrade } from '../src/lib/user-sockets.js';

const streams = new Set<PassThrough>();
function tracked(userId: string) {
  const stream = new PassThrough();
  streams.add(stream);
  const session = trackUserUpgrade(userId, stream);
  const ws = { close: vi.fn(), removeAllListeners: vi.fn() };
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
    closeUserSockets('a');
    closeUserSockets('a');
    expect(closed.ws.close).not.toHaveBeenCalled();
    expect(other.ws.close).not.toHaveBeenCalled();
    expect(live.ws.close).toHaveBeenCalledExactlyOnceWith(1008, 'session_revoked');
    expect(live.ws.removeAllListeners).toHaveBeenCalledExactlyOnceWith('message');
  });

  it('an old dispose cannot remove a newer bucket for the same user', () => {
    const old = tracked('c');
    old.session.dispose();
    const fresh = tracked('c');
    old.session.dispose();
    closeUserSockets('c');
    expect(fresh.ws.close).toHaveBeenCalledTimes(1);
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
