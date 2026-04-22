import { describe, expect, it } from 'vitest';
import {
  buildSetupTokenCommand,
  CliSetupTokenUnsupportedError,
  isCliSetupTokenSupported,
} from '../src/cli-adapters/setup-token-command.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

function makeProvider(
  overrides: Partial<CliProviderRecord> & Pick<CliProviderRecord, 'id' | 'name'>,
): CliProviderRecord {
  const now = new Date();
  return {
    id: overrides.id,
    userId: overrides.userId ?? 'user-1',
    name: overrides.name,
    label: overrides.label ?? `${overrides.name}`,
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

describe('isCliSetupTokenSupported', () => {
  it('is true for claude-code, codex, gemini, amp', () => {
    expect(isCliSetupTokenSupported('claude-code')).toBe(true);
    expect(isCliSetupTokenSupported('codex')).toBe(true);
    expect(isCliSetupTokenSupported('gemini')).toBe(true);
    expect(isCliSetupTokenSupported('amp')).toBe(true);
    expect(isCliSetupTokenSupported('zai')).toBe(false);
  });
});

describe('buildSetupTokenCommand', () => {
  it('claude-code → setup-token', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '1', name: 'claude-code' }), 'claude');
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual(['setup-token']);
  });

  it('codex → login --device-auth', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '2', name: 'codex' }), 'codex');
    expect(spec.command).toBe('codex');
    expect(spec.args).toEqual(['login', '--device-auth']);
  });

  it('gemini seeds settings + execs binary via sh -c', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '3', name: 'gemini' }), 'gemini');
    expect(spec.command).toBe('sh');
    expect(spec.args[0]).toBe('-c');
    const script = spec.args[1] ?? '';
    expect(script).toContain('mkdir -p "$HOME/.gemini"');
    expect(script).toContain('"selectedAuthType":"oauth-personal"');
    expect(script).toContain('"security":{"auth":{"selectedType":"oauth-personal"}}');
    expect(script).toContain('exec "$0"');
    expect(spec.args[2]).toBe('gemini');
    expect(spec.env.NO_BROWSER).toBe('true');
  });

  it('gemini merges provider envVars without overriding NO_BROWSER', () => {
    const spec = buildSetupTokenCommand(
      makeProvider({ id: '5', name: 'gemini', envVars: { FOO: 'bar', NO_BROWSER: 'false' } }),
      'gemini',
    );
    expect(spec.env.FOO).toBe('bar');
    expect(spec.env.NO_BROWSER).toBe('true');
  });

  it('amp → login', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '6', name: 'amp' }), 'amp');
    expect(spec.command).toBe('amp');
    expect(spec.args).toEqual(['login']);
  });

  it('throws CliSetupTokenUnsupportedError for zai', () => {
    expect(() => buildSetupTokenCommand(makeProvider({ id: '7', name: 'zai' }), 'claude')).toThrow(
      CliSetupTokenUnsupportedError,
    );
  });
});
