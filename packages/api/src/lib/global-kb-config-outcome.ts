import { classifyGlobalKbError } from '@haive/shared/global-kb';
/** Settings were published outside the store transaction; do not repeat their audit blindly. */
export class GlobalKbConfigOutcomeUnknownError extends Error {
  readonly code = 'global_kb_config_outcome_unknown';
  readonly errorClass;
  constructor(error: unknown) {
    super(
      'Global KB settings may have been saved, but store confirmation failed. Reload the settings before saving again.',
    );
    this.errorClass = classifyGlobalKbError(error);
    this.name = 'GlobalKbConfigOutcomeUnknownError';
  }
}
