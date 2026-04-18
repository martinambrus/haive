import { describe, expect, it } from 'vitest';
import {
  buildAuthProbeCommand,
  CliAuthProbeUnsupportedError,
  classifyAuthProbeOutput,
  isAuthProbeSupported,
} from '../src/cli-adapters/auth-probe.js';
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

describe('classifyAuthProbeOutput', () => {
  it('returns ok when exit code is 0 and no auth tokens matched', () => {
    const result = classifyAuthProbeOutput({
      stdout: 'pong\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result.status).toBe('ok');
  });

  it('detects 401 unauthorized as auth_expired', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: 'Error: 401 Unauthorized — token expired',
      exitCode: 1,
    });
    expect(result.status).toBe('auth_expired');
  });

  it('detects 403 forbidden as auth_denied', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: '403 Forbidden: access denied',
      exitCode: 1,
    });
    expect(result.status).toBe('auth_denied');
  });

  it('detects ENOTFOUND as network_error', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: 'getaddrinfo ENOTFOUND api.anthropic.com',
      exitCode: 1,
    });
    expect(result.status).toBe('network_error');
  });

  it('detects 429 rate_limited', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: '429 Too Many Requests',
      exitCode: 1,
    });
    expect(result.status).toBe('rate_limited');
  });

  it('flags timeout when timedOut true', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: true,
    });
    expect(result.status).toBe('timeout');
  });

  it('falls back to unknown_error for unrecognised failures', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: 'some weird crash',
      exitCode: 7,
    });
    expect(result.status).toBe('unknown_error');
  });

  it('detects please run claude /login prompt', () => {
    const result = classifyAuthProbeOutput({
      stdout: 'Please run claude /login to authenticate',
      stderr: '',
      exitCode: 1,
    });
    expect(result.status).toBe('auth_expired');
  });

  it('detects "Not logged in · Please run /login" claude output', () => {
    const result = classifyAuthProbeOutput({
      stdout: '',
      stderr: 'Not logged in · Please run /login',
      exitCode: 1,
    });
    expect(result.status).toBe('auth_expired');
  });

  it('detects bare /login mention', () => {
    const result = classifyAuthProbeOutput({
      stdout: 'Run /login first',
      stderr: '',
      exitCode: 1,
    });
    expect(result.status).toBe('auth_expired');
  });

  it('treats exit 0 with 401 text as auth_expired (guard)', () => {
    const result = classifyAuthProbeOutput({
      stdout: 'Warning: 401 unauthorized, cached reply returned',
      stderr: '',
      exitCode: 0,
    });
    expect(result.status).toBe('auth_expired');
  });
});

describe('buildAuthProbeCommand', () => {
  it('builds claude-code spec with -p flag', () => {
    const spec = buildAuthProbeCommand(makeProvider({ id: '1', name: 'claude-code' }), 'claude');
    expect(spec.command).toBe('claude');
    expect(spec.args).toContain('-p');
    expect(spec.args).toContain('respond with the single word pong');
    expect(spec.args).toContain('--output-format');
  });

  it('builds codex spec with exec subcommand', () => {
    const spec = buildAuthProbeCommand(makeProvider({ id: '2', name: 'codex' }), 'codex');
    expect(spec.command).toBe('codex');
    expect(spec.args[0]).toBe('exec');
  });

  it('throws CliAuthProbeUnsupportedError for gemini', () => {
    expect(() =>
      buildAuthProbeCommand(makeProvider({ id: '3', name: 'gemini' }), 'gemini'),
    ).toThrow(CliAuthProbeUnsupportedError);
  });
});

describe('isAuthProbeSupported', () => {
  it('is true for claude-code and codex only', () => {
    expect(isAuthProbeSupported('claude-code')).toBe(true);
    expect(isAuthProbeSupported('codex')).toBe(true);
    expect(isAuthProbeSupported('gemini')).toBe(false);
    expect(isAuthProbeSupported('amp')).toBe(false);
  });
});
