import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { ProviderBuildError } from '../src/cli-adapters/prompt-delivery.js';
import { CliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';

type Overrides = Partial<CliProviderRecord> & Pick<CliProviderRecord, 'id' | 'name' | 'createdAt'>;

function makeProvider(overrides: Overrides): CliProviderRecord {
  return {
    userId: 'user-1',
    label: `${overrides.name} label`,
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: false,
    authMode: 'subscription',
    enabled: true,
    updatedAt: overrides.createdAt,
    ...overrides,
  } as CliProviderRecord;
}

const ollama = makeProvider({
  id: 'prov-ollama',
  name: 'ollama',
  label: 'ollama-old',
  createdAt: new Date('2026-01-01T00:00:00Z'),
});
const claude = makeProvider({
  id: 'prov-claude',
  name: 'claude-code',
  createdAt: new Date('2026-02-01T00:00:00Z'),
});

const dispatch = (
  providers: CliProviderRecord[],
  preferredProviderId: string | null,
  registry?: CliAdapterRegistry,
) =>
  resolveDispatch({
    providers,
    preferredProviderId,
    input: { kind: 'prompt', prompt: 'p', capabilities: [] },
    invokeOpts: {},
    registry,
  });

describe('a provider that cannot build a command', () => {
  it('falls through to the next provider when it was an implicit default', () => {
    const plan = dispatch([ollama, claude], null);
    expect(plan.providerId).toBe('prov-claude');
  });

  it('keeps the failure visible when it was the explicitly selected provider', () => {
    let caught: unknown;
    try {
      dispatch([ollama, claude], 'prov-ollama');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderBuildError);
    expect((caught as ProviderBuildError).providerName).toBe('ollama-old');
    expect((caught as ProviderBuildError).message).toMatch(/model/);
  });

  it('uses the explicitly selected provider when another one cannot build', () => {
    const plan = dispatch([ollama, claude], 'prov-claude');
    expect(plan.providerId).toBe('prov-claude');
  });

  it('treats a disabled explicit pick as no pick and falls through', () => {
    const disabled = makeProvider({
      id: 'prov-disabled',
      name: 'claude-code',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      enabled: false,
    });
    const plan = dispatch([ollama, claude, disabled], 'prov-disabled');
    expect(plan.providerId).toBe('prov-claude');
  });

  it('throws the first cause when no candidate builds', () => {
    const newer = {
      ...ollama,
      id: 'prov-ollama-2',
      label: 'ollama-new',
      createdAt: claude.createdAt,
    };
    let caught: unknown;
    try {
      dispatch([newer, ollama], null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderBuildError);
    expect((caught as ProviderBuildError).providerName).toBe('ollama-old');
  });

  it('stays fatal for an error that is not a ProviderBuildError', () => {
    class ThrowingAdapter extends ClaudeCodeAdapter {
      override buildCliInvocation(): never {
        throw new TypeError('boom');
      }
    }
    class ThrowingRegistry extends CliAdapterRegistry {
      override get(name: Parameters<CliAdapterRegistry['get']>[0]) {
        return name === 'ollama' ? new ThrowingAdapter() : super.get(name);
      }
    }
    expect(() => dispatch([ollama, claude], null, new ThrowingRegistry())).toThrow(TypeError);
  });
});
