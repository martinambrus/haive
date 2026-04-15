import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { splitSubAgentForProvider } from '../src/sub-agent-emulator/splitter.js';
import { buildCodexSequentialInvocation } from '../src/sub-agent-emulator/codex-mode.js';
import { buildAmpSequentialInvocation } from '../src/sub-agent-emulator/amp-mode.js';
import type {
  CliProviderName,
  CliProviderRecord,
  SubAgentSpec,
} from '../src/cli-adapters/types.js';

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

const spec: SubAgentSpec = {
  subAgents: [
    { name: 'scanner', prompt: 'List suspicious files', outputKey: 'files' },
    { name: 'labeler', prompt: 'Label each file', outputKey: 'labels' },
  ],
  synthesisPrompt: 'Produce a markdown report',
};

describe('splitSubAgentForProvider', () => {
  it('uses native mode for claude-code', () => {
    const provider = makeProvider({
      id: 'p-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const adapter = cliAdapterRegistry.get('claude-code');
    const result = splitSubAgentForProvider(adapter, provider, spec, {});
    expect(result.mode).toBe('native');
    expect(result.invocation.mode).toBe('native');
    expect(result.invocation.steps).toHaveLength(2);
    expect(result.reason).toBe('native_subagents');
  });

  it('uses native mode for codex', () => {
    const provider = makeProvider({
      id: 'p-codex',
      name: 'codex',
      supportsSubagents: true,
    });
    const adapter = cliAdapterRegistry.get('codex');
    const result = splitSubAgentForProvider(adapter, provider, spec, {});
    expect(result.mode).toBe('native');
    expect(result.invocation.mode).toBe('native');
    expect(result.invocation.steps.map((s) => s.collectInto)).toEqual(['files', 'labels']);
    expect(result.reason).toBe('native_subagents');
  });

  it('uses native mode for amp', () => {
    const provider = makeProvider({
      id: 'p-amp',
      name: 'amp',
      supportsSubagents: true,
    });
    const adapter = cliAdapterRegistry.get('amp');
    const result = splitSubAgentForProvider(adapter, provider, spec, {});
    expect(result.mode).toBe('native');
    expect(result.invocation.steps.map((s) => s.id)).toEqual(['scanner', 'labeler']);
  });

  it('produces a capability matrix for every registered provider', () => {
    const names: CliProviderName[] = [
      'claude-code',
      'codex',
      'gemini',
      'amp',
      'grok',
      'qwen',
      'kiro',
      'zai',
    ];
    const matrix = names.map((name) => {
      const provider = makeProvider({
        id: `p-${name}`,
        name,
        supportsSubagents: true,
      });
      const adapter = cliAdapterRegistry.get(name);
      const result = splitSubAgentForProvider(adapter, provider, spec, {});
      return { name, mode: result.mode };
    });
    expect(matrix).toEqual([
      { name: 'claude-code', mode: 'native' },
      { name: 'codex', mode: 'native' },
      { name: 'gemini', mode: 'native' },
      { name: 'amp', mode: 'native' },
      { name: 'grok', mode: 'native' },
      { name: 'qwen', mode: 'native' },
      { name: 'kiro', mode: 'native' },
      { name: 'zai', mode: 'native' },
    ]);
  });
});

describe('sequential builders', () => {
  it('codex builder embeds the output key list in the synthesis prompt', () => {
    const inv = buildCodexSequentialInvocation(spec);
    expect(inv.synthesis.prompt).toContain('files, labels');
    expect(inv.synthesis.prompt).toContain('Produce a markdown report');
  });

  it('amp builder skips JSON fence tokens in favor of fenced blocks', () => {
    const inv = buildAmpSequentialInvocation(spec);
    expect(inv.steps[0]?.prompt).not.toContain('<<<JSON>>>');
    expect(inv.steps[0]?.prompt).toContain('fenced block');
  });
});
