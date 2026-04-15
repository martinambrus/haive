import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';

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

const sampleSubAgentSpec: SubAgentSpec = {
  subAgents: [
    { name: 'detector', prompt: 'Detect project type', outputKey: 'detect' },
    { name: 'analyzer', prompt: 'Analyze detect output', outputKey: 'analysis' },
  ],
  synthesisPrompt: 'Summarize results',
};

describe('resolveDispatch', () => {
  it('returns skip when there are no enabled providers', () => {
    const plan = resolveDispatch({
      providers: [],
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toBe('no enabled cli providers');
  });

  it('picks the preferred provider first when set', () => {
    const claude = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const codex = makeProvider({
      id: 'prov-codex',
      name: 'codex',
    });
    const plan = resolveDispatch({
      providers: [codex, claude],
      preferredProviderId: 'prov-claude',
      input: { kind: 'prompt', prompt: 'hello', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-claude');
    expect(plan.mode).toBe('cli');
  });

  it('emits a native sub-agent invocation for claude-code', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'subagent', spec: sampleSubAgentSpec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('cli');
    expect(plan.reason).toBe('native_subagents');
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.mode).toBe('native');
      expect(plan.invocation.spec.steps).toHaveLength(2);
    }
  });

  it('emits a sequential sub-agent invocation for codex', () => {
    const provider = makeProvider({
      id: 'prov-codex',
      name: 'codex',
      supportsSubagents: false,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'subagent', spec: sampleSubAgentSpec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('subagent_emulated');
    expect(plan.reason).toBe('sequential_emulation');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.mode).toBe('sequential');
      expect(plan.invocation.spec.steps).toHaveLength(2);
    }
  });

  it('uses the api path for api_key providers on a plain prompt', () => {
    const provider = makeProvider({
      id: 'prov-gemini',
      name: 'gemini',
      authMode: 'api_key',
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'what is 2+2', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('api');
    expect(plan.reason).toBe('api_byok');
    expect(plan.invocation?.kind).toBe('api');
  });

  it('skips disabled providers entirely', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      enabled: false,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
  });

  it('builds a CliCommandSpec using the resolved executable', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      executablePath: '/usr/local/bin/claude',
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'status?', capabilities: [] },
      invokeOpts: { cwd: '/repo' },
      registry: cliAdapterRegistry,
    });
    expect(plan.mode).toBe('cli');
    if (plan.invocation?.kind === 'cli') {
      expect(plan.invocation.spec.command).toBe('/usr/local/bin/claude');
      expect(plan.invocation.spec.args).toContain('status?');
      expect(plan.invocation.spec.cwd).toBe('/repo');
    }
  });
});
