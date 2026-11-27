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

/** No CLI has run: retry admission without spending an agent recovery budget. */
export class CliAuthRetryableError extends Error {
  constructor(readonly code: 'cli_auth_busy' | 'cli_auth_probe_unknown') {
    super(`${code}: Authentication is busy or could not be verified; retrying admission.`);
    this.name = 'CliAuthRetryableError';
  }
}

/** Admission could not be verified within its bounded automatic retry allowance. */
export class CliAuthProbeExhaustedError extends Error {
  constructor() {
    super(
      'cli_auth_probe_exhausted: Authentication could not be verified. Check Docker and the stored login, then Retry.',
    );
    this.name = 'CliAuthProbeExhaustedError';
  }
}

export const MAX_AUTH_PROBE_UNKNOWNS = 20;
export const AUTH_ADMISSION_RETRY_DELAY_MS = 30_000;
