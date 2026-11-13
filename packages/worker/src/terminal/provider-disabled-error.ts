import { TERMINAL_PROVIDER_DISABLED_MESSAGE } from '@haive/shared';

/** A shell refused because its provider is disabled; the api closes it with code 4425. */
export class TerminalProviderDisabledError extends Error {
  constructor() {
    super(TERMINAL_PROVIDER_DISABLED_MESSAGE);
    this.name = 'TerminalProviderDisabledError';
  }
}
