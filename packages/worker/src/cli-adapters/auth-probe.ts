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

// Gemini's folder-trust feature, when enabled, overrides --yolo to "default"
// and prints a warning whenever the CWD is not in trustedFolders.json. The
// override forces the probe prompt to require interactive approval and exit
// non-zero. Credentials themselves are valid in this state — auth completed,
// the failure is purely environmental. We treat this as `ok` so the user
// isn't told their saved credentials are broken when they're not.
//
// Note: "YOLO mode is enabled" is NOT in this pattern. Gemini prints that
// banner unconditionally with --yolo, including on auth-fail exits — leaving
// it here would mask "Please set an Auth method" failures as ok.
const TRUST_OVERRIDE_PATTERN =
  /approval[_\s-]?mode[_\s-]?overridden|folder[_\s-]?is[_\s-]?not[_\s-]?trusted/i;

// Gemini's no-creds error message. Distinct enough that we surface it as
// auth_expired so the UI prompts a re-login instead of "unknown_error".
const AUTH_METHOD_MISSING_PATTERN =
  /please[_\s-]?set[_\s-]?an[_\s-]?auth[_\s-]?method|specify[_\s-]?one[_\s-]?of[_\s-]?the[_\s-]?following[_\s-]?environment[_\s-]?variables/i;

const PATTERNS: Array<{ pattern: RegExp; status: CliAuthStatus }> = [
  {
    pattern: /\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|quota[_\s-]?exceeded/i,
    status: 'rate_limited',
  },
  {
    pattern:
      /authorization[_\s-]?denied|access[_\s-]?denied|permission[_\s-]?denied|forbidden|\b403\b|manual\s+authorization\s+is\s+required|fatalauthenticationerror/i,
    status: 'auth_denied',
  },
  {
    pattern: /invalid[_\s-]?client|invalid[_\s-]?grant|client[_\s-]?error/i,
    status: 'auth_denied',
  },
  {
    pattern:
      /invalid[_\s-]?token|(?:invalid|missing)[_\s-]?(?:or[_\s-]+missing[_\s-]+)?api[_\s-]?key|token[_\s-]?expired|sub[_\s-]?expired|credentials[_\s-]?expired|re[-_\s]?auth|not[_\s-]?authenticated|not[_\s-]?logged[_\s-]?in|\bunauthor(ised|ized)\b|\b401\b|please[_\s-]?log[_\s-]?in|please[_\s-]?run[^\n]*\/?login|\/login\b|\blog\s*in\s+(?:required|needed)|run\s+['"]?amp\s+login/i,
    status: 'auth_expired',
  },
  // Gemini's "Please set an Auth method..." stderr — fired when ~/.gemini has
  // no oauth_creds.json and no GEMINI_API_KEY env. Treat as auth_expired so
  // the UI offers a re-login button instead of "unknown_error".
  {
    pattern: AUTH_METHOD_MISSING_PATTERN,
    status: 'auth_expired',
  },
  {
    pattern:
      /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|getaddrinfo|network[_\s-]?error/i,
    status: 'network_error',
  },
];

const FRIENDLY_MESSAGES: Record<CliAuthStatus, string> = {
  ok: 'authenticated',
  auth_expired: 'credentials expired — please sign in again',
  auth_denied: 'authentication required — please sign in',
  rate_limited: 'rate limited by provider',
  network_error: 'network error reaching provider',
  timeout: 'auth probe timed out',
  unknown_error: 'auth probe failed',
  unknown: 'auth status unknown',
};

export function classifyAuthProbeOutput(result: AuthProbeExecResult): AuthProbeClassification {
  if (result.timedOut) {
    return { status: 'timeout', message: FRIENDLY_MESSAGES.timeout };
  }

  const haystack = `${result.stdout}\n${result.stderr}`;

  if (result.exitCode === 0 && !AUTH_FAILURE_GUARD.test(haystack)) {
    return { status: 'ok', message: FRIENDLY_MESSAGES.ok };
  }

  for (const { pattern, status } of PATTERNS) {
    if (pattern.test(haystack)) {
      return { status, message: FRIENDLY_MESSAGES[status] };
    }
  }

  if (TRUST_OVERRIDE_PATTERN.test(haystack) && !AUTH_FAILURE_GUARD.test(haystack)) {
    return { status: 'ok', message: FRIENDLY_MESSAGES.ok };
  }

  const tail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return {
    status: 'unknown_error',
    message: tail.slice(0, 300),
  };
}

export function isAuthProbeSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex' || name === 'gemini' || name === 'amp';
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
    case 'gemini':
      return {
        command: executable,
        args: ['-p', AUTH_PROBE_PROMPT, '--output-format', 'text', '--yolo'],
        // GEMINI_CLI_TRUST_WORKSPACE bypasses the folder-trust prompt for the
        // session so --yolo isn't overridden when the sandbox workdir isn't
        // in the user's trustedFolders.json. Without this, gemini downgrades
        // approval mode to "default" and the probe prompt fails non-interactively.
        env: { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      };
    case 'amp':
      // `amp usage` hits the Amp API to read the credit balance — fast
      // (~1s) and auth-discriminating. `amp -x "pong"` in contrast sends a
      // full LLM round-trip which routinely exceeds the 25s probe budget.
      return {
        command: executable,
        args: ['usage'],
        env,
      };
    default:
      throw new CliAuthProbeUnsupportedError(provider.name);
  }
}
