import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { encryptCliLoginCandidate, envelopeEncrypt, type CliProbeJobPayload } from '@haive/shared';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  factory: vi.fn(),
  update: vi.fn(),
  readSecrets: vi.fn(),
  fail: false,
  throwOutput: false,
}));

const KEK = 'ab'.repeat(32);
const USER = 'candidate-owner';
const PROVIDER = 'candidate-provider';
// Synthetic credentials; Boolean assertions keep them out of test diagnostics.
const CANDIDATE = 'synthetic-candidate-434';
const OLD = 'synthetic-working-434';
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  secretsService: { getMasterKek: async () => 'ab'.repeat(32) },
}));
vi.mock('../src/queues/cli-exec/exec-core.js', () => ({
  createSandboxSpawner: (...args: unknown[]) => {
    h.factory(...args);
    return h.spawn;
  },
}));
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: () => ({ tag: 'haive-cli-sandbox-claude:test' }),
}));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { inspect: async () => ({ exists: true }) },
}));
import { handleProbeJob } from '../src/queues/cli-exec/handlers.js';

let provider: Record<string, unknown>;
let db: Database;
const payload = (): CliProbeJobPayload => ({
  providerId: PROVIDER,
  userId: USER,
  targetMode: 'cli',
  oauthCandidate: encryptCliLoginCandidate(USER, PROVIDER, CANDIDATE, KEK),
});
beforeEach(() => {
  vi.clearAllMocks();
  h.fail = false;
  h.throwOutput = false;
  provider = {
    id: PROVIDER,
    userId: USER,
    name: 'claude-code',
    authMode: 'subscription',
    executablePath: '/usr/local/bin/claude',
    wrapperPath: null,
    wrapperContent: null,
    envVars: {
      ANTHROPIC_API_KEY: OLD,
      ANTHROPIC_AUTH_TOKEN: OLD,
      CLAUDE_CODE_OAUTH_TOKEN: OLD,
      ANTHROPIC_CUSTOM_HEADERS: OLD,
      CLAUDE_CODE_MAX_OUTPUT: '100',
    },
    isolateAuth: false,
    cliVersion: null,
    sandboxDockerfileExtra: null,
  };
  h.readSecrets.mockResolvedValue([
    {
      secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
      ...envelopeEncrypt(OLD, KEK),
    },
  ]);
  db = {
    query: {
      cliProviders: { findFirst: async () => provider },
      cliProviderSecrets: { findMany: h.readSecrets },
    },
    update: () => ({ set: (value: unknown) => ({ where: async () => h.update(value) }) }),
  } as unknown as Database;
  h.spawn.mockImplementation(async (spec) => {
    if (h.throwOutput) throw new Error(CANDIDATE);
    if (spec.args[0] === '--version') return { exitCode: 0, stdout: CANDIDATE, stderr: '' };
    const valid = !h.fail && spec.env.CLAUDE_CODE_OAUTH_TOKEN === CANDIDATE;
    return { exitCode: valid ? 0 : 1, stdout: valid ? 'pong' : CANDIDATE, stderr: '' };
  });
});

describe('login candidate queue consumer and sandbox credential boundary', () => {
  it('decrypts the producer envelope and tests only the candidate with no auth volume', async () => {
    const job = payload();
    expect(JSON.stringify(job).includes(CANDIDATE)).toBe(false);
    const result = await handleProbeJob(db, job);
    expect(result.ok && result.cli?.ok && result.cli.authStatus === 'ok').toBe(true);
    expect(h.readSecrets.mock.calls.length === 0).toBe(true);
    expect(h.update.mock.calls.length === 0).toBe(true);
    expect(h.factory.mock.calls[0]?.[7]).toEqual([]);
    const auth = h.spawn.mock.calls.find(([spec]) => spec.args[0] !== '--version')?.[0];
    expect(auth.command === '/usr/local/bin/claude').toBe(true);
    expect(Object.keys(auth.env).sort()).toEqual([
      'CLAUDE_CODE_MAX_OUTPUT',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(auth.env.CLAUDE_CODE_MAX_OUTPUT).toBe('100');
    expect(auth.env.CLAUDE_CODE_OAUTH_TOKEN === CANDIDATE).toBe(true);
    expect(JSON.stringify(result).includes(CANDIDATE)).toBe(false);
  });

  it.each(['failure', 'throw'] as const)(
    'keeps candidate %s diagnostics out of queue results and active health',
    async (kind) => {
      h.fail = kind === 'failure';
      h.throwOutput = kind === 'throw';
      const result = await handleProbeJob(db, payload());
      expect(result.ok).toBe(false);
      expect(h.update.mock.calls.length === 0).toBe(true);
      expect(JSON.stringify(result).includes(CANDIDATE)).toBe(false);
      expect(h.readSecrets.mock.calls.length === 0).toBe(true);
    },
  );

  it.each(['owner', 'provider', 'purpose', 'ciphertext', 'provider-owner'])(
    'refuses a candidate with a mismatched %s before executing',
    async (kind) => {
      const job = payload();
      if (kind === 'owner') job.userId = 'another-owner';
      if (kind === 'provider') job.providerId = 'another-provider';
      if (kind === 'purpose')
        job.oauthCandidate = envelopeEncrypt(
          JSON.stringify({
            purpose: 'another-use',
            userId: USER,
            providerId: PROVIDER,
            token: CANDIDATE,
          }),
          KEK,
        );
      if (kind === 'ciphertext') job.oauthCandidate!.encryptedValue = 'not-an-envelope';
      if (kind === 'provider-owner') provider.userId = 'another-owner';
      await expect(handleProbeJob(db, job)).rejects.toThrow('Invalid login candidate');
      expect(h.spawn.mock.calls.length === 0 && h.update.mock.calls.length === 0).toBe(true);
    },
  );

  it.each(['wrapperPath', 'wrapperContent'])(
    'preserves configured %s while supplying only the candidate credential',
    async (field) => {
      provider[field] = 'custom-wrapper';
      const result = await handleProbeJob(db, payload());
      expect(result.ok).toBe(true);
      expect(h.factory.mock.calls[0]?.[0] === provider.wrapperContent).toBe(true);
      expect(h.factory.mock.calls[0]?.[7]).toEqual([]);
      const auth = h.spawn.mock.calls[1]?.[0];
      expect(auth.command === (provider.wrapperPath ?? provider.executablePath)).toBe(true);
      expect(auth.env.CLAUDE_CODE_OAUTH_TOKEN === CANDIDATE).toBe(true);
      expect(Object.values(auth.env).includes(OLD)).toBe(false);
    },
  );

  it('retains stored-token probes, auth mounts and provider health writes', async () => {
    h.spawn.mockImplementation(async () => ({
      exitCode: 0,
      stdout: 'fixture version',
      stderr: '',
    }));
    const result = await handleProbeJob(db, {
      providerId: PROVIDER,
      userId: USER,
      targetMode: 'cli',
    });
    expect(result.ok).toBe(true);
    expect(h.readSecrets.mock.calls.length).toBe(1);
    expect(h.update.mock.calls.length).toBe(1);
    expect(h.factory.mock.calls[0]?.[7]?.length > 0).toBe(true);
    const auth = h.spawn.mock.calls[1]?.[0];
    expect(auth.env.CLAUDE_CODE_OAUTH_TOKEN === OLD).toBe(true);
  });
});
