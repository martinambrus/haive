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
  it('is true for claude-code, codex, amp, antigravity; false for gemini (BYOK-only) and zai', () => {
    expect(isCliSetupTokenSupported('claude-code')).toBe(true);
    expect(isCliSetupTokenSupported('codex')).toBe(true);
    expect(isCliSetupTokenSupported('amp')).toBe(true);
    expect(isCliSetupTokenSupported('antigravity')).toBe(true);
    expect(isCliSetupTokenSupported('gemini')).toBe(false);
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

  it('throws CliSetupTokenUnsupportedError for gemini (BYOK-only, no CLI login)', () => {
    expect(() =>
      buildSetupTokenCommand(makeProvider({ id: '3', name: 'gemini' }), 'gemini'),
    ).toThrow(CliSetupTokenUnsupportedError);
  });

  it('amp → login', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '6', name: 'amp' }), 'amp');
    expect(spec.command).toBe('amp');
    expect(spec.args).toEqual(['login']);
  });

  it('antigravity → interactive agy (-i) for terminal-passthrough login', () => {
    const spec = buildSetupTokenCommand(makeProvider({ id: '8', name: 'antigravity' }), 'agy');
    expect(spec.command).toBe('agy');
    expect(spec.args).toContain('-i');
    expect(spec.args).not.toContain('-p');
  });

  it('throws CliSetupTokenUnsupportedError for zai', () => {
    expect(() => buildSetupTokenCommand(makeProvider({ id: '7', name: 'zai' }), 'claude')).toThrow(
      CliSetupTokenUnsupportedError,
    );
  });
});
