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

describe('grok adapter', () => {
  const adapter = cliAdapterRegistry.get('grok');
  const provider = makeProvider({ id: 'p-grok', name: 'grok' });

  it('declares expected capability flags', () => {
    expect(adapter.providerName).toBe('grok');
    expect(adapter.defaultExecutable).toBe('grok');
    expect(adapter.supportsSubagents).toBe(false);
    expect(adapter.supportsApi).toBe(true);
    expect(adapter.supportsCliAuth).toBe(true);
    expect(adapter.defaultAuthMode).toBe('mixed');
    expect(adapter.apiKeyEnvName).toBe('XAI_API_KEY');
    expect(adapter.defaultModel).toBe('grok-3');
  });

  it('builds a CLI invocation with -p prompt flag', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('grok');
    expect(spec.args).toEqual(['-p', 'hello']);
    expect(spec.cwd).toBe('/work/repo');
  });

  it('builds an API invocation targeting the xAI OpenAI-compatible endpoint', () => {
    const spec = adapter.buildApiInvocation!(provider, 'hello', opts);
    expect(spec.sdkPackage).toBe('openai');
    expect(spec.baseUrl).toBe('https://api.x.ai/v1');
    expect(spec.apiKeyEnvName).toBe('XAI_API_KEY');
    expect(spec.defaultModel).toBe('grok-3');
    expect(spec.model).toBe('grok-3');
  });

  it('honors modelOverride from opts', () => {
    const spec = adapter.buildApiInvocation!(provider, 'hello', { modelOverride: 'grok-4' });
    expect(spec.model).toBe('grok-4');
  });

  it('exposes grok auth directories for sandbox copy-in', () => {
    const inj = adapter.envInjection(provider);
    const srcs = inj.copyPaths.map((p) => p.src);
    expect(srcs).toContain('~/.config/grok');
    expect(srcs).toContain('~/.grok');
    for (const path of inj.copyPaths) {
      expect(path.optional).toBe(true);
      expect(path.mode).toBe('dir');
    }
  });
});

describe('qwen adapter', () => {
  const adapter = cliAdapterRegistry.get('qwen');
  const provider = makeProvider({ id: 'p-qwen', name: 'qwen' });

  it('declares expected capability flags', () => {
    expect(adapter.providerName).toBe('qwen');
    expect(adapter.defaultExecutable).toBe('qwen');
    expect(adapter.supportsSubagents).toBe(false);
    expect(adapter.supportsApi).toBe(true);
    expect(adapter.apiKeyEnvName).toBe('DASHSCOPE_API_KEY');
    expect(adapter.defaultModel).toBe('qwen-max');
  });

  it('builds a CLI invocation with -p prompt flag', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('qwen');
    expect(spec.args).toEqual(['-p', 'hello']);
  });

  it('builds an API invocation targeting the DashScope OpenAI-compatible endpoint', () => {
    const spec = adapter.buildApiInvocation!(provider, 'hello', opts);
    expect(spec.sdkPackage).toBe('openai');
    expect(spec.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(spec.apiKeyEnvName).toBe('DASHSCOPE_API_KEY');
    expect(spec.defaultModel).toBe('qwen-max');
  });

  it('exposes qwen auth directory for sandbox copy-in', () => {
    const inj = adapter.envInjection(provider);
    expect(inj.copyPaths).toHaveLength(1);
    expect(inj.copyPaths[0]?.src).toBe('~/.qwen');
    expect(inj.copyPaths[0]?.optional).toBe(true);
  });
});

describe('kiro adapter', () => {
  const adapter = cliAdapterRegistry.get('kiro');
  const provider = makeProvider({ id: 'p-kiro', name: 'kiro' });

  it('declares CLI-only capability with no API and subscription auth', () => {
    expect(adapter.providerName).toBe('kiro');
    expect(adapter.defaultExecutable).toBe('kiro');
    expect(adapter.supportsApi).toBe(false);
    expect(adapter.supportsCliAuth).toBe(true);
    expect(adapter.defaultAuthMode).toBe('subscription');
    expect(adapter.apiKeyEnvName).toBeNull();
    expect(adapter.defaultModel).toBeNull();
  });

  it('passes the prompt positionally without a -p flag', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('kiro');
    expect(spec.args).toEqual(['hello']);
  });

  it('does not expose a buildApiInvocation method', () => {
    expect(adapter.buildApiInvocation).toBeUndefined();
  });

  it('exposes kiro auth directory for sandbox copy-in', () => {
    const inj = adapter.envInjection(provider);
    expect(inj.copyPaths).toHaveLength(1);
    expect(inj.copyPaths[0]?.src).toBe('~/.kiro');
  });
});

describe('zai adapter', () => {
  const adapter = cliAdapterRegistry.get('zai');
  const provider = makeProvider({ id: 'p-zai', name: 'zai' });

  it('declares the claude CLI executable and mixed auth', () => {
    expect(adapter.providerName).toBe('zai');
    expect(adapter.defaultExecutable).toBe('claude');
    expect(adapter.supportsSubagents).toBe(true);
    expect(adapter.supportsApi).toBe(true);
    expect(adapter.defaultAuthMode).toBe('mixed');
    expect(adapter.apiKeyEnvName).toBe('ANTHROPIC_API_KEY');
  });

  it('appends --output-format json to CLI invocations', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual(['-p', 'hello', '--output-format', 'json']);
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
    expect(spec.env.ANTHROPIC_API_KEY).toBe('secret-token');
    expect(spec.env.Z_AI_MODEL).toBe('glm-4.6');
    expect(spec.env.CLAUDE_MODEL).toBe('glm-4.6');
  });

  it('leaves ANTHROPIC_* env vars untouched when Z_AI_* are absent', () => {
    const zProvider = makeProvider({
      id: 'p-zai-bare',
      name: 'zai',
      envVars: { ANTHROPIC_API_KEY: 'direct-key' },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('builds an API invocation against the Anthropic SDK and the zai base URL', () => {
    const spec = adapter.buildApiInvocation!(provider, 'hello', opts);
    expect(spec.sdkPackage).toBe('@anthropic-ai/sdk');
    expect(spec.baseUrl).toBe('https://api.zai.com/v1');
    expect(spec.apiKeyEnvName).toBe('ANTHROPIC_API_KEY');
  });

  it('exposes claude config directories for sandbox copy-in', () => {
    const inj = adapter.envInjection(provider);
    const srcs = inj.copyPaths.map((p) => p.src);
    expect(srcs).toContain('~/.config/claude');
    expect(srcs).toContain('~/.claude');
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
