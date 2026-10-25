import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/sandbox/login-container.js', () => ({ createSandboxLoginContainer: h.create }));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { run: async () => ({ exitCode: 0 }) },
}));
vi.mock('../src/cli-adapters/registry.js', () => ({
  cliAdapterRegistry: { has: () => true, get: () => ({ defaultExecutable: 'claude' }) },
}));
vi.mock('../src/cli-adapters/setup-token-command.js', () => ({
  buildSetupTokenCommand: () => ({ executable: 'claude', args: [] }),
}));

import { logger } from '@haive/shared';
import { handleLoginCreateJob } from '../src/queues/cli-exec/handlers.js';

afterEach(() => vi.restoreAllMocks());

it('returns a safe failure when the container insert binds environment secrets', async () => {
  const secret = randomBytes(24).toString('base64url');
  h.create.mockRejectedValueOnce(
    new DrizzleQueryError(
      'insert into containers (env_vars) values ($1)',
      [secret],
      new Error(secret),
    ),
  );
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => ({ id: 'provider', userId: 'user', name: 'claude-code' }),
      },
    },
  };
  // The shared serializer itself is exercised with the real DB control; do not print a fixture here.
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const result = await handleLoginCreateJob(db as never, {
    providerId: 'provider',
    userId: 'user',
  });
  expect(result.ok).toBe(false);
  const text = JSON.stringify(result);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
  expect(h.create).toHaveBeenCalledOnce();
});
