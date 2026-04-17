import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderName, CliProviderRecord } from '../src/cli-adapters/types.js';

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
    effortLevel: overrides.effortLevel ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  } as CliProviderRecord;
}

describe('effortScale declarations', () => {
  it('claude-code exposes the four-level scale with max=max', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'max']);
    expect(adapter.effortScale!.max).toBe('max');
  });

  it('zai mirrors the claude-code scale because it wraps the same binary', () => {
    const adapter = cliAdapterRegistry.get('zai');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'max']);
    expect(adapter.effortScale!.max).toBe('max');
  });

  it.each<CliProviderName>(['codex', 'gemini', 'amp', 'grok', 'qwen', 'kiro'])(
    '%s reports no effort knob (effortScale=null)',
    (name) => {
      const adapter = cliAdapterRegistry.get(name);
      expect(adapter.effortScale).toBeNull();
    },
  );
});

describe('effortEnv emission', () => {
  it('claude-code translates each declared level into CLAUDE_CODE_EFFORT_LEVEL', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    for (const level of adapter.effortScale!.values) {
      expect(adapter.effortEnv(level)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level });
    }
  });

  it('codex (no scale) returns an empty env regardless of level', () => {
    const adapter = cliAdapterRegistry.get('codex');
    expect(adapter.effortEnv('high')).toEqual({});
    expect(adapter.effortEnv('whatever')).toEqual({});
  });
});

describe('mergedEnv resolution through buildCliInvocation', () => {
  it('falls back to scale.max when provider.effortLevel is null', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('uses provider.effortLevel when set to a valid value', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code', effortLevel: 'medium' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
  });

  it('opts.effortLevel overrides provider.effortLevel', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code', effortLevel: 'low' });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      effortLevel: 'high',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  it('drops invalid levels rather than poisoning the CLI env', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({
      id: 'p1',
      name: 'claude-code',
      effortLevel: 'super-extreme',
    });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('emits no effort env for adapters with effortScale=null', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex', effortLevel: 'high' });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      effortLevel: 'max',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('preserves provider.envVars and opts.extraEnv around the effort injection', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({
      id: 'p1',
      name: 'claude-code',
      envVars: { FOO: 'bar' },
      effortLevel: 'medium',
    });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      extraEnv: { BAZ: 'qux' },
    });
    expect(spec.env.FOO).toBe('bar');
    expect(spec.env.BAZ).toBe('qux');
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
  });
});
