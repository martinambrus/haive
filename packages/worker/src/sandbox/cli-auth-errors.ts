import type { StepErrorHint } from '@haive/shared';

/** Shared by mount admission and the CLI handler's inline login affordance. */
export class CliLoginRequiredError extends Error {
  constructor(
    message: string,
    readonly hint: StepErrorHint,
    readonly code = 'cli_login_required',
  ) {
    super(`${code}: ${message}`);
    this.name = 'CliLoginRequiredError';
  }
}

/** The VALUES are persisted in `cli_invocations.error_message` as `<code>:` prefixes; never change them. */
export const CLI_AUTH_BUSY = 'cli_auth_busy' as const;
export const CLI_AUTH_PROBE_UNKNOWN = 'cli_auth_probe_unknown' as const;
export type CliAuthRetryableCode = typeof CLI_AUTH_BUSY | typeof CLI_AUTH_PROBE_UNKNOWN;

/** The prefix a stored error message of this code starts with. */
export function cliAuthStoredPrefix(code: CliAuthRetryableCode): string {
  return `${code}:`;
}

/** No CLI has run: retry admission without spending an agent recovery budget. */
export class CliAuthRetryableError extends Error {
  constructor(readonly code: CliAuthRetryableCode) {
    super(
      `${cliAuthStoredPrefix(code)} Authentication is busy or could not be verified; retrying admission.`,
    );
    this.name = 'CliAuthRetryableError';
  }
}

/** Admission could not be verified within its bounded automatic retry allowance. */
export class CliAuthProbeExhaustedError extends Error {
  constructor() {
    super(
      'cli_auth_probe_exhausted: Authentication could not be verified. Check Docker and the stored login, then Retry or, where the step offers it, Resume.',
    );
    this.name = 'CliAuthProbeExhaustedError';
  }
}

/** Bounds distinct admission WAVES (30 s buckets of unknown results) per step run, not rows. */
export const MAX_AUTH_PROBE_UNKNOWNS = 20;
export const AUTH_ADMISSION_RETRY_DELAY_MS = 30_000;
