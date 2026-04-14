import { describe, expect, it } from 'vitest';
import { TerminalLogBuffer } from '../src/terminal/log-buffer.js';

describe('TerminalLogBuffer', () => {
  it('starts empty', () => {
    const buf = new TerminalLogBuffer();
    expect(buf.hasPending()).toBe(false);
    const snap = buf.snapshot();
    expect(snap.fullLog).toBe('');
    expect(snap.byteCount).toBe(0);
    expect(snap.truncated).toBe(false);
  });

  it('append accumulates text and marks dirty', () => {
    const buf = new TerminalLogBuffer();
    buf.append('hello');
    buf.append(' world');
    expect(buf.hasPending()).toBe(true);
    const snap = buf.snapshot();
    expect(snap.fullLog).toBe('hello world');
    expect(snap.byteCount).toBe(11);
    expect(snap.truncated).toBe(false);
  });

  it('counts bytes for multibyte utf8', () => {
    const buf = new TerminalLogBuffer();
    buf.append('caf\u00e9');
    const snap = buf.snapshot();
    expect(snap.fullLog).toBe('café');
    expect(snap.byteCount).toBe(5);
  });

  it('consume clears the dirty flag but keeps the log', () => {
    const buf = new TerminalLogBuffer();
    buf.append('alpha');
    expect(buf.hasPending()).toBe(true);
    const snap = buf.consume();
    expect(snap.fullLog).toBe('alpha');
    expect(buf.hasPending()).toBe(false);
    buf.append('beta');
    expect(buf.hasPending()).toBe(true);
    expect(buf.snapshot().fullLog).toBe('alphabeta');
  });

  it('drops oldest characters when cap exceeded and marks truncated', () => {
    const buf = new TerminalLogBuffer(10);
    buf.append('0123456789abcdef');
    const snap = buf.snapshot();
    expect(snap.fullLog).toBe('6789abcdef');
    expect(snap.fullLog.length).toBe(10);
    expect(snap.truncated).toBe(true);
    expect(snap.byteCount).toBe(16);
  });

  it('stays untruncated when under cap after many appends', () => {
    const buf = new TerminalLogBuffer(1024);
    for (let i = 0; i < 10; i += 1) buf.append('x');
    const snap = buf.snapshot();
    expect(snap.fullLog).toBe('xxxxxxxxxx');
    expect(snap.truncated).toBe(false);
  });

  it('ignores empty chunks', () => {
    const buf = new TerminalLogBuffer();
    buf.append('');
    expect(buf.hasPending()).toBe(false);
    expect(buf.snapshot().byteCount).toBe(0);
  });

  it('exposes capChars', () => {
    const buf = new TerminalLogBuffer(2048);
    expect(buf.capChars).toBe(2048);
  });
});
