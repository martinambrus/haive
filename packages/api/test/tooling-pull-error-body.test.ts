import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

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

const MIB = 1024 * 1024;

/** A body served 1 KiB per read, only when a read asks for it, so the reads can be counted. */
function streamed(bytes: Uint8Array, status: number) {
  const seen = { pulls: 0, cancelled: false };
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 1024));
        offset += 1024;
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { res: new Response(body, { status }), seen };
}

async function pullErrors(): Promise<string[]> {
  const app = new Hono().route('/tooling', toolingRoutes);
  const res = await app.request('/tooling/pull-ollama-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ollamaUrl: 'http://ollama.invalid', model: 'm' }),
  });
  const events = (await res.text()).split('\n\n').filter((block) => block.includes('event: error'));
  return events.map((block) => {
    const data = block.split('\n').find((line) => line.startsWith('data: '));
    return (JSON.parse(data!.slice('data: '.length)) as { error: string }).error;
  });
}

it('reads a bounded excerpt of a 10 MiB Ollama error body and cancels the rest', async () => {
  const { res, seen } = streamed(Buffer.from('e'.repeat(10 * MIB)), 500);
  h.fetchFn = vi.fn(async () => res);

  const errors = await pullErrors();

  expect(errors).toEqual([`Ollama returned HTTP 500: ${'e'.repeat(200)}`]);
  expect(seen).toEqual({ pulls: 5, cancelled: true });
});

it('keeps the short error text it always showed, whole', async () => {
  const { res, seen } = streamed(Buffer.from('model "m" not found, try pulling it first'), 404);
  h.fetchFn = vi.fn(async () => res);

  const errors = await pullErrors();

  expect(errors).toEqual(['Ollama returned HTTP 404: model "m" not found, try pulling it first']);
  expect(seen.cancelled).toBe(false);
});
