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
