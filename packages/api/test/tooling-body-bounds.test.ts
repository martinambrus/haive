import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { endpointBody, oversizedJson } from '../../../tests/fixtures/endpoint-body.mjs';

const h = vi.hoisted(() => ({ fetchFn: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('../src/lib/probe-hosts.js', () => ({
  probeEgressFor: async () => ({ fetchFn: h.fetchFn }),
}));
vi.mock('@haive/shared/forge', async (original) => {
  const real = await original<typeof import('@haive/shared/forge')>();
  return {
    ...real,
    readForgeJson: (res: Response, max = real.FORGE_RESPONSE_MAX_BYTES) =>
      real.readForgeJson(res, Math.min(max, 128)),
  };
});
import { toolingRoutes } from '../src/routes/tooling.js';
const app = new Hono().route('/tooling', toolingRoutes);

it.each([
  ['test-ollama', { models: [{ name: 'm' }] }],
  ['ollama-model-capabilities', { capabilities: ['thinking'] }],
] as const)('bounds %s success JSON from a user endpoint', async (route, data) => {
  const endpoint = await endpointBody(200, oversizedJson(data));
  h.fetchFn = endpoint.fetchFn;
  try {
    const response = await app.request(`/tooling/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollamaUrl: endpoint.url, model: 'm' }),
    });
    expect(await response.json()).toMatchObject({
      reachable: false,
      error: 'response is larger than 128 bytes',
    });
    expect(endpoint.cancelled).toBe(true);
  } finally {
    await endpoint.close();
  }
});

it.each([
  ['test-ollama', 500],
  ['ollama-model-capabilities', 404],
  ['ollama-model-capabilities', 500],
] as const)('cancels unread %s HTTP %i bodies beyond the test bound', async (route, status) => {
  const endpoint = await endpointBody(status, oversizedJson({}), true);
  h.fetchFn = endpoint.fetchFn;
  try {
    await app.request(`/tooling/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollamaUrl: endpoint.url, model: 'm' }),
    });
    expect(endpoint.cancelled).toBe(true);
    await endpoint.upstreamClosed;
  } finally {
    await endpoint.close();
  }
});
