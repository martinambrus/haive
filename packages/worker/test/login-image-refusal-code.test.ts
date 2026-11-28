import { beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CLI_LOGIN_REFUSAL_CODES } from '@haive/shared';

// Only the image call is replaced: the refusal class is the real one, and the handler under test
// decides the wire code from that class and its reason, never from what the message says.
const ensure = vi.hoisted(() => vi.fn());
vi.mock('../src/queues/cli-exec/images.js', async (original) => ({
  ...(await original<typeof import('../src/queues/cli-exec/images.js')>()),
  ensureProviderSandboxImage: ensure,
}));
vi.mock('../src/cli-adapters/registry.js', () => ({
  cliAdapterRegistry: { has: () => true, get: () => ({ defaultExecutable: 'codex' }) },
}));
vi.mock('../src/cli-adapters/setup-token-command.js', () => ({
  buildSetupTokenCommand: () => ({ executable: 'codex', args: [] }),
}));

import { handleLoginCreateJob } from '../src/queues/cli-exec/handlers.js';
import { SandboxImageUnavailableError } from '../src/queues/cli-exec/images.js';

const payload = { providerId: 'provider', userId: 'user' };
const db = {
  query: {
    cliProviders: {
      findFirst: async () => ({ id: 'provider', userId: 'user', name: 'codex' }),
    },
  },
} as unknown as Database;
/** The wording `ensureProviderSandboxImage` uses for a build someone else is running. */
const IN_PROGRESS = 'sandbox image build is in progress, please wait for it to finish and retry';

beforeEach(() => ensure.mockReset());

it.each([
  ['building', 'words that say nothing', CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_BUILDING],
  ['failed', IN_PROGRESS, CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_FAILED],
] as const)(
  'codes a %s refusal from its reason, whatever the message says',
  async (reason, message, code) => {
    ensure.mockRejectedValueOnce(new SandboxImageUnavailableError(reason, message));
    await expect(handleLoginCreateJob(db, payload)).resolves.toEqual({
      ok: false,
      error: message,
      code,
    });
  },
);

it('gives an error that is not the refusal class no code, even with the same words', async () => {
  ensure.mockRejectedValueOnce(new Error(IN_PROGRESS));
  await expect(handleLoginCreateJob(db, payload)).resolves.toEqual({
    ok: false,
    error: IN_PROGRESS,
  });
});
