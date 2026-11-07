import { Hono } from 'hono';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchFn: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('../src/lib/probe-hosts.js', () => ({
  probeEgressFor: async () => ({ fetchFn: h.fetchFn }),
}));

import { toolingRoutes } from '../src/routes/tooling.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const encoder = new TextEncoder();

interface Seen {
  pulls: number;
  cancelled: boolean;
}

/** A body fed by `next` (null closes it), one chunk per read, so the reads can be counted. */
function body(next: (pull: number) => Uint8Array | null | 'hang') {
  const seen: Seen = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        const chunk = next(seen.pulls);
        if (chunk === 'hang') return new Promise<void>(() => {});
        if (chunk === null) return controller.close();
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

function app() {
  return new Hono().route('/tooling', toolingRoutes);
}

function start() {
  return app().request('/tooling/pull-ollama-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ollamaUrl: 'http://ollama.invalid', model: 'm' }),
  });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.includes('event: '))
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))!.slice('event: '.length);
      const data = lines.find((l) => l.startsWith('data: '))!.slice('data: '.length);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function pull(): Promise<SseEvent[]> {
  return parse(await (await start()).text());
}

/** Runs a pull under fake timers and lets the idle window pass in one-minute slices. */
async function pullIdle(): Promise<SseEvent[]> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = Promise.resolve(start()).then((res) => res.text());
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(60_000);
  return parse(await pending);
}

const errorsOf = (events: SseEvent[]) =>
  events.filter((e) => e.event === 'error').map((e) => e.data.error as string);

const line = (status: string) => encoder.encode(`${JSON.stringify({ status })}\n`);

afterEach(() => {
  vi.useRealTimers();
});

it('stops a line that never ends near 64 KiB and cancels the body', async () => {
  const chunk = encoder.encode('a'.repeat(KIB));
  const { stream, seen } = body((n) => (n > 1024 ? null : chunk));
  h.fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));

  const events = await pull();

  expect(errorsOf(events)).toEqual(['Ollama pull stopped: a line from the server exceeded 64 KiB']);
  expect(events.some((e) => e.event === 'done' || e.event === 'cancelled')).toBe(false);
  expect(seen.cancelled).toBe(true);
  expect(seen.pulls).toBeLessThanOrEqual(80);
});

it('stops a stream over 64 MiB in total and cancels the body before its end', async () => {
  const perChunk = 64 * KIB;
  // 16 KiB valid lines keep the SSE event count low while the bytes still add up.
  const one = `${JSON.stringify({ status: 'pulling', digest: 'x'.repeat(16 * KIB - 40) })}\n`;
  const chunk = encoder.encode(one.repeat(Math.floor(perChunk / one.length)));
  const chunks = Math.ceil((65 * MIB) / chunk.byteLength);
  const { stream, seen } = body((n) => (n > chunks ? null : chunk));
  h.fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));

  const events = await pull();

  expect(errorsOf(events)).toEqual([
    'Ollama pull stopped: more than 64 MiB of progress was streamed',
  ]);
  expect(events.some((e) => e.event === 'done' || e.event === 'cancelled')).toBe(false);
  expect(seen.cancelled).toBe(true);
  expect(seen.pulls).toBeLessThan(chunks);
});

const IDLE_ERROR = 'Ollama pull stopped: the server sent nothing for 10 minutes';

it('stops a body that goes quiet after one line', async () => {
  const { stream, seen } = body((n) => (n === 1 ? line('pulling') : 'hang'));
  h.fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));

  const events = await pullIdle();

  expect(errorsOf(events)).toEqual([IDLE_ERROR]);
  expect(events.filter((e) => e.event === 'progress')).toHaveLength(1);
  expect(events.some((e) => e.event === 'done' || e.event === 'cancelled')).toBe(false);
  expect(seen.cancelled).toBe(true);
});

it('stops when the upstream never answers and aborts the request', async () => {
  let signal: AbortSignal | undefined;
  h.fetchFn = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
    signal = init.signal;
    return new Promise<Response>(() => {});
  });

  const events = await pullIdle();

  expect(errorsOf(events)).toEqual([IDLE_ERROR]);
  expect(events.some((e) => e.event === 'done' || e.event === 'cancelled')).toBe(false);
  expect(signal?.aborted).toBe(true);
});

it('stops a non-OK answer whose body never ends and aborts the request', async () => {
  let signal: AbortSignal | undefined;
  const { stream } = body((n) => (n === 1 ? encoder.encode('boom') : 'hang'));
  h.fetchFn = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
    signal = init.signal;
    return new Response(stream, { status: 500 });
  });

  const events = await pullIdle();

  expect(errorsOf(events)).toEqual([IDLE_ERROR]);
  expect(events.some((e) => e.event === 'done' || e.event === 'cancelled')).toBe(false);
  expect(signal?.aborted).toBe(true);
});

it('cuts an in-stream error to 200 characters and keeps a short one whole', async () => {
  const long = encoder.encode(`${JSON.stringify({ error: 'e'.repeat(500) })}\n`);
  h.fetchFn = vi.fn(async () => new Response(long, { status: 200 }));
  expect(errorsOf(await pull())).toEqual(['e'.repeat(200)]);

  const short = encoder.encode(`${JSON.stringify({ error: 'nope' })}\n`);
  h.fetchFn = vi.fn(async () => new Response(short, { status: 200 }));
  expect(errorsOf(await pull())).toEqual(['nope']);
});

it('still relays a healthy stream: three progress events, one done, no error', async () => {
  const text = ['a', 'b', 'c'].map((s) => JSON.stringify({ status: s })).join('\n') + '\n';
  h.fetchFn = vi.fn(async () => new Response(encoder.encode(text), { status: 200 }));

  const events = await pull();

  expect(events.filter((e) => e.event === 'progress')).toHaveLength(3);
  expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
  expect(errorsOf(events)).toEqual([]);
});

it('releases the upstream after an in-stream error line', async () => {
  const { stream, seen } = body((n) =>
    n === 1 ? encoder.encode(`${JSON.stringify({ error: 'gone' })}\n`) : 'hang',
  );
  h.fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));

  const events = await pull();

  expect(errorsOf(events)).toEqual(['gone']);
  expect(seen.cancelled).toBe(true);
});

it('still reports a user cancel as cancelled, not as an error', async () => {
  h.fetchFn = vi.fn(
    async (_url: string, init: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(line('pulling'));
            init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
        { status: 200 },
      ),
  );
  const application = app();
  const res = await application.request('/tooling/pull-ollama-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ollamaUrl: 'http://ollama.invalid', model: 'm' }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cancelled = false;
  while (!cancelled) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const start = parse(text).find((e) => e.event === 'start');
    if (start && text.includes('event: progress')) {
      const cancel = await application.request('/tooling/cancel-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pullId: start.data.pullId }),
      });
      expect(await cancel.json()).toEqual({ ok: true, cancelled: true });
      cancelled = true;
    }
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  const events = parse(text);
  expect(events.some((e) => e.event === 'cancelled')).toBe(true);
  expect(errorsOf(events)).toEqual([]);
});

it('retained heap during one pull does not grow with the number of reads', async () => {
  const gc =
    globalThis.gc ?? (v8.setFlagsFromString('--expose-gc'), vm.runInNewContext('gc') as () => void);
  const reads = 400_000;
  const newline = encoder.encode('\n');
  let base = 0;
  let end = 0;
  const { stream } = body((n) => {
    if (n === 2000) {
      gc();
      base = process.memoryUsage().heapUsed;
    }
    if (n === reads - 2000) {
      gc();
      end = process.memoryUsage().heapUsed;
    }
    return n > reads ? null : newline;
  });
  h.fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));
  const events = await pull();
  expect(events.some((e) => e.event === 'done')).toBe(true);
  expect((end - base) / 1e6).toBeLessThan(30);
}, 30_000);
