import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { envelopeEncrypt } from '@haive/shared';

const KEK = 'ab'.repeat(32);
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  secretsService: { getMasterKek: async () => 'ab'.repeat(32) },
}));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));

import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';

describe('terminal provider shell env', () => {
  it('keeps the usage grant out of the shell env and keeps the login token', async () => {
    const token = randomBytes(16).toString('hex');
    const grant = randomBytes(16).toString('hex');
    const db = {
      query: {
        cliProviders: {
          findFirst: async () => ({ id: 'prov-1', userId: 'user-1', name: 'claude-code' }),
        },
        cliProviderSecrets: {
          findMany: async () => [
            { secretName: 'CLAUDE_CODE_OAUTH_TOKEN', ...envelopeEncrypt(token, KEK) },
            { secretName: 'CLAUDE_USAGE_OAUTH', ...envelopeEncrypt(grant, KEK) },
          ],
        },
      },
    } as unknown as Database;
    const mgr = new TerminalSessionManager({
      db,
      redis: {} as never,
      subscriberRedis: { on: vi.fn() } as never,
      docker: {} as never,
      buildMcpServers: async () => [],
    });
    const priv = mgr as unknown as {
      resolveProviderShellEnv: (
        scope: { userId: string },
        providerId: string,
      ) => Promise<Record<string, string>>;
    };
    const env = await priv.resolveProviderShellEnv({ userId: 'user-1' }, 'prov-1');
    expect(Object.keys(env).includes('CLAUDE_USAGE_OAUTH')).toBe(false);
    expect(Object.values(env).includes(grant)).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
  });
});
