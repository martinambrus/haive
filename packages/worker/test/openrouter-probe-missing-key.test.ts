import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// The defect this pins was not a wrong predicate, it was MISSING COVERAGE: OpenRouter
// sits outside isAuthProbeSupported, so probeCliPath's short branch only ran
// `claude --version` — which succeeds with or without credentials — and reported a
// green Test for a provider that had no API key at all. Every step then died on the
// binary's own "Not logged in · Please run /login". So the test drives probeCliPath
// itself rather than the predicate, and the sandbox spawn is mocked to SUCCEED: a
// passing version probe is exactly the condition that used to mask the missing key.
const spawn = vi.fn(() =>
  Promise.resolve({ exitCode: 0, stdout: '2.0.0 (Claude Code)', stderr: '' }),
);
vi.mock('../src/queues/cli-exec/exec-core.js', () => ({
  createSandboxSpawner: () => spawn,
}));
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: () => ({ tag: 'haive-cli-sandbox-openrouter:test' }),
}));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { inspect: () => Promise.resolve({ exists: true }) },
}));
// Pulled in only for the inline-build fallback, which a cached image never reaches.
vi.mock('../src/queues/cli-exec/handlers.js', () => ({
  handleBuildSandboxImageJob: () => Promise.resolve({ ok: true, imageTag: 'unused' }),
}));

const compat = vi.fn(() => Promise.resolve({ compatible: true }));
vi.mock('../src/cli-adapters/openrouter-compat.js', () => ({
  probeOpenRouterModelCompat: compat,
}));

const { probeCliPath } = await import('../src/queues/cli-exec/images.js');
const { cliAdapterRegistry } = await import('../src/cli-adapters/registry.js');

const adapter = cliAdapterRegistry.get('openrouter');
const db = {} as Database;

function makeProvider(overrides: Partial<CliProviderRecord>): CliProviderRecord {
  return {
    id: 'provider-1',
    userId: 'user-1',
    name: 'openrouter',
    label: 'OpenRouter',
    executablePath: null,
    wrapperPath: null,
    wrapperContent: null,
    envVars: null,
    cliArgs: null,
    model: 'google/gemini-3.7-flash',
    authMode: 'api_key',
    isolateAuth: false,
    enabled: true,
    cliVersion: null,
    sandboxDockerfileExtra: null,
    ...overrides,
  } as CliProviderRecord;
}

describe('probeCliPath: openrouter with no API key', () => {
  it('fails the test instead of reporting ok', async () => {
    const result = await probeCliPath(db, adapter, makeProvider({}), {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No OpenRouter API key');
    // The binary itself is fine — the version detail must still be reported, so the
    // user is told which of the two things is wrong.
    expect(result.detail).toContain('2.0.0');
    // Returned WITHOUT an authStatus: nothing ever writes auth_status back to `ok` for
    // an api_key row, so a status set here would outlive the user adding the key.
    expect(result.authStatus).toBeUndefined();
    // Fires before the model round-trip, which is pointless with no token to send.
    expect(compat).not.toHaveBeenCalled();
  });

  it('accepts a key held as a secret', async () => {
    const result = await probeCliPath(db, adapter, makeProvider({}), {
      ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-test',
    });

    expect(result.ok).toBe(true);
    expect(compat).toHaveBeenCalled();
  });

  it('accepts a key held in the provider env vars', async () => {
    const result = await probeCliPath(
      db,
      adapter,
      makeProvider({ envVars: { ANTHROPIC_API_KEY: 'sk-or-v1-test' } }),
      {},
    );

    expect(result.ok).toBe(true);
  });

  it('leaves a keyless model-less provider of another wrapper CLI alone', async () => {
    // ollama falls back to the literal `ollama` token its local daemon accepts, so an
    // empty key set is its normal in-stack state and must not fail the probe.
    const result = await probeCliPath(
      db,
      cliAdapterRegistry.get('ollama'),
      makeProvider({ name: 'ollama', model: 'qwen3.8:4b' }),
      {},
    );

    expect(result.ok).toBe(true);
  });
});
