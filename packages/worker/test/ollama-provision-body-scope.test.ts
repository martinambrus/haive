import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { endpointBody, oversizedJson } from '../../../tests/fixtures/endpoint-body.mjs';
import { provisionOllamaProvider } from '../src/sandbox/ollama-provision.js';

const realFetch = globalThis.fetch;
afterEach(() => vi.restoreAllMocks());

// Reproduction attempt for review L3: expose the same over-bound loopback replies,
// but keep the real external-daemon routing decision. Never dial the dev daemon.
it.each([
  ['tags', 200, null],
  ['pull', 500, null],
  ['create', 500, 'FROM base'],
] as const)(
  'never reads a user-set daemon’s oversized %s body',
  async (_site, status, modelfile) => {
    const endpoint = await endpointBody(status, oversizedJson({ models: [] }), true);
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    const provider = {
      id: randomUUID(),
      userId: randomUUID(),
      model: 'custom',
      modelfile,
      envVars: { ANTHROPIC_BASE_URL: endpoint.url },
    };
    fake.insert(schema.cliProviders, provider);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).startsWith(`${endpoint.url}/`)) {
        throw new Error('fixture refuses any target other than its loopback endpoint');
      }
      return realFetch(input, init);
    });
    try {
      await expect(
        provisionOllamaProvider(fake.db as unknown as Database, provider),
      ).resolves.toEqual({
        ok: true,
        providerId: provider.id,
      });
      expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
        modelProvisionStatus: 'idle',
        modelProvisionError: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(endpoint.closed).toBe(false);
    } finally {
      await endpoint.close();
    }
  },
);
