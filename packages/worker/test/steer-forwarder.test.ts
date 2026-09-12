import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSteerForwarder } from '../src/queues/cli-exec/steer-forwarder.js';

function fakeSubscriber() {
  let handler: ((ch: string, raw: string) => void) | null = null;
  return {
    on(ev: string, cb: (ch: string, raw: string) => void) {
      if (ev === 'message') handler = cb;
    },
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    emitMessage: (raw: string) => handler?.('steer:in:x', raw),
  };
}

function fakeWritable() {
  const w = { writable: true, write: vi.fn(), end: vi.fn() };
  w.end.mockImplementation(() => {
    w.writable = false;
  });
  return w;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createSteerForwarder', () => {
  it('forwards a pre-result steer to stdin as one NDJSON user-message line', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const f = createSteerForwarder({ subscriber: sub as never });
    f.captureWritable(w as never);
    sub.emitMessage('focus on perf');
    expect(w.write).toHaveBeenCalledTimes(1);
    const written = w.write.mock.calls[0]![0] as string;
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written.trim()).message.content[0].text).toBe('focus on perf');
  });

  it('parses a JSON {id,text} payload, writes only the text, and reports onWritten', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const onWritten = vi.fn();
    const f = createSteerForwarder({ subscriber: sub as never, onWritten });
    f.captureWritable(w as never);
    sub.emitMessage(JSON.stringify({ id: 'steer-1', text: 'focus on perf' }));
    expect(w.write).toHaveBeenCalledTimes(1);
    const written = w.write.mock.calls[0]![0] as string;
    // The NDJSON line carries the text, not the {id,text} envelope.
    expect(JSON.parse(written.trim()).message.content[0].text).toBe('focus on perf');
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(onWritten).toHaveBeenCalledWith({ id: 'steer-1', text: 'focus on perf' });
  });

  it('carries the system marker through to onWritten, still writing it to stdin', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const onWritten = vi.fn();
    const f = createSteerForwarder({ subscriber: sub as never, onWritten });
    f.captureWritable(w as never);
    // The soft-timeout wind-down. It must still REACH the CLI — it is the only thing that
    // asks a run to bank its findings before the SIGKILL — but the echo downstream keeps it
    // out of the transcript, where it would read as something the user typed.
    sub.emitMessage(JSON.stringify({ id: '', system: true, text: 'TIME BUDGET NEARLY SPENT.' }));
    expect(w.write).toHaveBeenCalledTimes(1);
    expect(onWritten).toHaveBeenCalledWith({
      id: '',
      system: true,
      text: 'TIME BUDGET NEARLY SPENT.',
    });
  });

  it('never infers system from an empty id - a bare-string steer is human', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const onWritten = vi.fn();
    const f = createSteerForwarder({ subscriber: sub as never, onWritten });
    f.captureWritable(w as never);
    sub.emitMessage('legacy steer');
    expect(onWritten).toHaveBeenCalledWith({ id: '', text: 'legacy steer' });
  });

  describe('steerFlag', () => {
    const write = (steerFlag?: boolean) => {
      const sub = fakeSubscriber();
      const w = fakeWritable();
      const f = createSteerForwarder({ subscriber: sub as never, steerFlag });
      f.captureWritable(w as never);
      sub.emitMessage(JSON.stringify({ id: 'a', text: 'focus on perf' }));
      return w.write.mock.calls[0]![0] as string;
    };

    it('adds amp queue marker to a MID-RUN steer when set', () => {
      expect(JSON.parse(write(true).trim()).steer).toBe(true);
    });

    // Unset is the claude family, whose binary has no such field: the line must be exactly
    // what it has always been.
    it('emits the byte-identical legacy line when unset', () => {
      expect(write()).toBe(
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"focus on perf"}]}}\n',
      );
      expect(write(false)).toBe(write());
    });
  });

  it('falls back to a bare-string payload with an empty id (rolling-restart safety)', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const onWritten = vi.fn();
    const f = createSteerForwarder({ subscriber: sub as never, onWritten });
    f.captureWritable(w as never);
    sub.emitMessage('legacy bare text');
    const written = w.write.mock.calls[0]![0] as string;
    expect(JSON.parse(written.trim()).message.content[0].text).toBe('legacy bare text');
    expect(onWritten).toHaveBeenCalledWith({ id: '', text: 'legacy bare text' });
  });

  it('drops a steer that arrives after the result latch (one turn per invocation)', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const f = createSteerForwarder({ subscriber: sub as never, graceMs: 750 });
    f.captureWritable(w as never);
    f.onResult();
    sub.emitMessage('too late');
    expect(w.write).not.toHaveBeenCalled();
  });

  it('closes stdin once after grace and tears down the subscriber', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const f = createSteerForwarder({ subscriber: sub as never, graceMs: 750 });
    f.captureWritable(w as never);
    f.onResult();
    expect(w.end).not.toHaveBeenCalled(); // still within grace
    vi.advanceTimersByTime(750);
    expect(w.end).toHaveBeenCalledTimes(1);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });

  it('teardown is idempotent across the grace timer and the finally call', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const f = createSteerForwarder({ subscriber: sub as never, graceMs: 750 });
    f.captureWritable(w as never);
    f.onResult();
    vi.advanceTimersByTime(750); // teardown via grace
    f.teardown(); // teardown via finally
    expect(w.end).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });

  it('never writes after stdin end (write-after-end guard, Hole C)', () => {
    const sub = fakeSubscriber();
    const w = fakeWritable();
    const f = createSteerForwarder({ subscriber: sub as never, graceMs: 1 });
    f.captureWritable(w as never);
    f.onResult();
    vi.advanceTimersByTime(1); // stdin ended, w.writable=false
    sub.emitMessage('after end');
    expect(w.write).not.toHaveBeenCalled();
  });
});
