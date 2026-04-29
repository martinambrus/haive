import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord, InvokeOpts, SubAgentSpec } from '../src/cli-adapters/types.js';

type ProviderOverrides = Partial<CliProviderRecord> & Pick<CliProviderRecord, 'id' | 'name'>;

function makeProvider(overrides: ProviderOverrides): CliProviderRecord {
  const now = new Date();
  return {
    id: overrides.id,
    userId: overrides.userId ?? 'user-1',
    name: overrides.name,
    label: overrides.label ?? `${overrides.name} label`,
    executablePath: overrides.executablePath ?? null,
    wrapperPath: overrides.wrapperPath ?? null,
    envVars: overrides.envVars ?? null,
    cliArgs: overrides.cliArgs ?? null,
    supportsSubagents: overrides.supportsSubagents ?? false,
    authMode: overrides.authMode ?? 'subscription',
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  } as CliProviderRecord;
}

const opts: InvokeOpts = { cwd: '/work/repo' };

describe('zai adapter', () => {
  const adapter = cliAdapterRegistry.get('zai');
  const provider = makeProvider({ id: 'p-zai', name: 'zai' });

  it('declares the claude CLI executable and api-key auth via CLI binary', () => {
    expect(adapter.providerName).toBe('zai');
    expect(adapter.defaultExecutable).toBe('claude');
    expect(adapter.supportsSubagents).toBe(true);
    expect(adapter.supportsCliAuth).toBe(true);
    expect(adapter.defaultAuthMode).toBe('api_key');
    expect(adapter.apiKeyEnvName).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('appends --output-format stream-json --verbose to CLI invocations', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual([
      '--dangerously-skip-permissions',
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('rewrites Z_AI_* env vars into ANTHROPIC_*/CLAUDE_MODEL aliases', () => {
    const zProvider = makeProvider({
      id: 'p-zai-env',
      name: 'zai',
      envVars: {
        Z_AI_API_URL: 'https://api.zai.com/v1',
        Z_AI_API_KEY: 'secret-token',
        Z_AI_MODEL: 'glm-4.6',
      },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.Z_AI_API_URL).toBe('https://api.zai.com/v1');
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.zai.com/v1');
    expect(spec.env.Z_AI_API_KEY).toBe('secret-token');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-token');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('secret-token');
    expect(spec.env.Z_AI_MODEL).toBe('glm-4.6');
    expect(spec.env.CLAUDE_MODEL).toBe('glm-4.6');
  });

  it('defaults ANTHROPIC_BASE_URL to the canonical zai endpoint when unset', () => {
    const zProvider = makeProvider({
      id: 'p-zai-bare',
      name: 'zai',
      envVars: { Z_AI_API_KEY: 'only-token' },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('only-token');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('only-token');
  });

  it('promotes a bare ANTHROPIC_API_KEY into ANTHROPIC_AUTH_TOKEN for the claude binary', () => {
    const zProvider = makeProvider({
      id: 'p-zai-direct',
      name: 'zai',
      envVars: { ANTHROPIC_API_KEY: 'direct-key' },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('direct-key');
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });

  it('builds a native sub-agent invocation that mirrors claude-code', () => {
    const spec: SubAgentSpec = {
      subAgents: [
        { name: 'scanner', prompt: 'Find files', outputKey: 'files' },
        { name: 'labeler', prompt: 'Label them', outputKey: 'labels' },
      ],
      synthesisPrompt: 'Summarize findings',
    };
    const inv = adapter.buildSubAgentInvocation!(provider, spec, opts);
    expect(inv.mode).toBe('native');
    expect(inv.steps.map((s) => s.id)).toEqual(['scanner', 'labeler']);
    expect(inv.steps.map((s) => s.collectInto)).toEqual(['files', 'labels']);
    expect(inv.steps[0]?.prompt).toBe('Find files');
    expect(inv.steps.every((s) => s.expectJsonOutput)).toBe(true);
    expect(inv.synthesis.id).toBe('synthesis');
    expect(inv.synthesis.prompt).toBe('Summarize findings');
    expect(inv.synthesis.expectJsonOutput).toBe(true);
  });
});
