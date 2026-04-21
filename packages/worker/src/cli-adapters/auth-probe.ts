import type { CliAuthStatus } from '@haive/shared';
import type { CliCommandSpec, CliProviderName, CliProviderRecord } from './types.js';

export class CliAuthProbeUnsupportedError extends Error {
  readonly code = 'cli_auth_probe_unsupported';
  constructor(providerName: CliProviderName) {
    super(`auth probe not implemented for provider ${providerName}`);
    this.name = 'CliAuthProbeUnsupportedError';
  }
}

export interface AuthProbeClassification {
  status: CliAuthStatus;
  message: string;
}

export interface AuthProbeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

const AUTH_PROBE_PROMPT = 'respond with the single word pong';
const AUTH_FAILURE_GUARD = /invalid[_\s-]?token|unauthor(ised|ized)|\b401\b/i;

const PATTERNS: Array<{ pattern: RegExp; status: CliAuthStatus }> = [
  {
    pattern: /\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|quota[_\s-]?exceeded/i,
    status: 'rate_limited',
  },
  {
    pattern:
      /authorization[_\s-]?denied|access[_\s-]?denied|permission[_\s-]?denied|forbidden|\b403\b/i,
    status: 'auth_denied',
  },
  {
    pattern: /invalid[_\s-]?client|invalid[_\s-]?grant|client[_\s-]?error/i,
    status: 'auth_denied',
  },
  {
    pattern:
      /invalid[_\s-]?token|token[_\s-]?expired|sub[_\s-]?expired|credentials[_\s-]?expired|re[-_\s]?auth|not[_\s-]?authenticated|not[_\s-]?logged[_\s-]?in|\bunauthor(ised|ized)\b|\b401\b|please[_\s-]?log[_\s-]?in|please[_\s-]?run[^\n]*\/?login|\/login\b|\blog\s*in\s+(?:required|needed)/i,
    status: 'auth_expired',
  },
  {
    pattern:
      /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|getaddrinfo|network[_\s-]?error/i,
    status: 'network_error',
  },
];

export function classifyAuthProbeOutput(result: AuthProbeExecResult): AuthProbeClassification {
  if (result.timedOut) {
    return { status: 'timeout', message: 'auth probe timed out' };
  }

  const haystack = `${result.stdout}\n${result.stderr}`;

  if (result.exitCode === 0 && !AUTH_FAILURE_GUARD.test(haystack)) {
    return { status: 'ok', message: 'auth probe succeeded' };
  }

  for (const { pattern, status } of PATTERNS) {
    const match = haystack.match(pattern);
    if (match) {
      return {
        status,
        message: `matched ${status} pattern: ${match[0]}`,
      };
    }
  }

  const tail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return {
    status: 'unknown_error',
    message: tail.slice(0, 300),
  };
}

export function isAuthProbeSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex';
}

export function buildAuthProbeCommand(
  provider: CliProviderRecord,
  executable: string,
): CliCommandSpec {
  const env = provider.envVars ?? {};
  switch (provider.name) {
    case 'claude-code':
      return {
        command: executable,
        args: [
          '-p',
          AUTH_PROBE_PROMPT,
          '--output-format',
          'text',
          '--dangerously-skip-permissions',
        ],
        env,
      };
    case 'codex':
      return {
        command: executable,
        args: ['exec', '--skip-git-repo-check', AUTH_PROBE_PROMPT],
        env,
      };
    default:
      throw new CliAuthProbeUnsupportedError(provider.name);
  }
}
