import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { buildAuthProbeCommand, isAuthProbeSupported } from '../src/cli-adapters/auth-probe.js';
import {
  buildSetupTokenCommand,
  isCliSetupTokenSupported,
} from '../src/cli-adapters/setup-token-command.js';
import type { CliProviderName, CliProviderRecord } from '../src/cli-adapters/types.js';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  secretsService: { getMasterKek: async () => 'ab'.repeat(32) },
}));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));

import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';

const USAGE_KEY = 'CLAUDE_USAGE_OAUTH';

function makeProvider(name: string, envVars: Record<string, string>): CliProviderRecord {
  const now = new Date();
  return {
    id: 'prov-1',
    userId: 'user-1',
    name,
    label: name,
    executablePath: null,
    wrapperPath: null,
    envVars,
    cliArgs: null,
    supportsSubagents: false,
    authMode: 'subscription',
    enabled: true,
    effortLevel: null,
    model: 'fixture-model',
    createdAt: now,
    updatedAt: now,
  } as CliProviderRecord;
}

function expectStripped(env: Record<string, string>, grant: string): void {
  expect(Object.keys(env).includes(USAGE_KEY)).toBe(false);
  expect(Object.values(env).includes(grant)).toBe(false);
}

function expectStoredIntact(provider: CliProviderRecord): void {
  expect(Object.keys(provider.envVars ?? {}).sort()).toEqual([USAGE_KEY, 'KEEP_ME']);
}

const adapterNames = (): CliProviderName[] => cliAdapterRegistry.names();

describe('worker-only usage grant typed into the plain env', () => {
  it('has adapters to cover', () => {
    expect(adapterNames().length > 0).toBe(true);
  });

  it.each(adapterNames())('%s run env drops it and keeps other entries', (name) => {
    const grant = randomBytes(16).toString('hex');
    const provider = makeProvider(name, { [USAGE_KEY]: grant, KEEP_ME: 'k' });
    const spec = cliAdapterRegistry.get(name).buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expectStripped(spec.env ?? {}, grant);
    expect(spec.env?.KEEP_ME).toBe('k');
    expectStoredIntact(provider);
  });

  it.each(adapterNames())('%s shell env drops it and keeps the rest', (name) => {
    const grant = randomBytes(16).toString('hex');
    const token = randomBytes(16).toString('hex');
    const provider = makeProvider(name, { [USAGE_KEY]: grant, KEEP_ME: 'k' });
    const env = cliAdapterRegistry
      .get(name)
      .buildShellEnv(provider, { CLAUDE_CODE_OAUTH_TOKEN: token }, { EXTRA: 'e' });
    expectStripped(env, grant);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN === token).toBe(true);
    expect(env.KEEP_ME).toBe('k');
    expect(env.EXTRA).toBe('e');
    expectStoredIntact(provider);
  });

  it.each(['no-such-adapter', 'claude-code'])(
    'terminal shell env of provider %s drops it',
    async (name) => {
      const grant = randomBytes(16).toString('hex');
      const provider = makeProvider(name, { [USAGE_KEY]: grant, KEEP_ME: 'k' });
      const db = {
        query: {
          cliProviders: { findFirst: async () => provider },
          cliProviderSecrets: { findMany: async () => [] },
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
      expectStripped(env, grant);
      expect(env.KEEP_ME).toBe('k');
      expectStoredIntact(provider);
    },
  );

  it.each(adapterNames().filter((n) => isAuthProbeSupported(n)))(
    '%s auth probe env drops it',
    (name) => {
      const grant = randomBytes(16).toString('hex');
      const provider = makeProvider(name, { [USAGE_KEY]: grant, KEEP_ME: 'k' });
      const spec = buildAuthProbeCommand(provider, '/bin/cli');
      expectStripped(spec.env ?? {}, grant);
      expect(spec.env?.KEEP_ME).toBe('k');
      expectStoredIntact(provider);
    },
  );

  it.each(adapterNames().filter((n) => isCliSetupTokenSupported(n)))(
    '%s setup-token env drops it',
    (name) => {
      const grant = randomBytes(16).toString('hex');
      const provider = makeProvider(name, { [USAGE_KEY]: grant, KEEP_ME: 'k' });
      const spec = buildSetupTokenCommand(provider, '/bin/cli');
      expectStripped(spec.env ?? {}, grant);
      expect(spec.env?.KEEP_ME).toBe('k');
      expectStoredIntact(provider);
    },
  );
});
