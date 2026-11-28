import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/routes/browser-vnc.ts', import.meta.url), 'utf8');
const body = stripTypeScriptTypes(
  source.slice(source.indexOf('function runVncBridge('), source.indexOf('function extractTaskId(')),
);

function rig(admission: () => Promise<void>) {
  const events = new EventEmitter();
  const tcp = Object.assign(events, {
    destroyed: false,
    paused: false,
    writes: [] as string[],
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
      events.emit('data', Buffer.from('VNC greeting'));
    },
    destroy() {
      this.destroyed = true;
    },
    write(bytes: Buffer) {
      this.writes.push(bytes.toString());
    },
  });
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
  });
  const bridge = new Function(
    'net',
    'WebSocket',
    'log',
    'requireIdeCheckout',
    `${body}; return runVncBridge;`,
  )({ connect: () => tcp }, { OPEN: 1, CONNECTING: 0 }, { info() {} }, admission);
  bridge(ws, 'runner', 5900, 'task', {}, { epoch: 'accepted' });
  return { tcp, ws };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('holds Browser input and the VNC greeting until checkout admission completes at TCP attach', async () => {
  vi.useFakeTimers();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const { tcp, ws } = rig(() => gate);
  tcp.emit('connect');
  ws.emit('message', Buffer.from('early input'));
  expect(tcp.writes).toEqual([]);
  expect(ws.send).not.toHaveBeenCalled();
  expect(tcp.paused).toBe(true);
  resume();
  await Promise.resolve();
  expect(ws.send).toHaveBeenCalledWith(Buffer.from('VNC greeting'));
  ws.emit('message', Buffer.from('current input'));
  expect(tcp.writes).toEqual(['current input']);
});

it('ends a Browser bridge whose checkout was replaced while its TCP connection was pending', async () => {
  vi.useFakeTimers();
  const { tcp, ws } = rig(async () => {
    throw Object.assign(new Error('arbitrary text'), { code: 'checkout_unavailable' });
  });
  tcp.emit('connect');
  await Promise.resolve();
  ws.emit('message', Buffer.from('must not reach old mount'));
  expect(tcp.destroyed).toBe(true);
  expect(tcp.writes).toEqual([]);
  expect(ws.close).toHaveBeenCalledOnce();
  expect(ws.send).not.toHaveBeenCalled();
});
