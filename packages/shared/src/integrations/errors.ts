import type { schema } from '@haive/database';

type ConnectionStatus = typeof schema.integrationConnections.$inferSelect.status;

export class NeedsReauthError extends Error {
  constructor(
    readonly connectionId: string,
    readonly status: ConnectionStatus,
  ) {
    super(`integration connection ${connectionId} needs to be connected again (${status})`);
    this.name = 'NeedsReauthError';
  }
}

export class ConnectionNotFoundError extends Error {
  constructor(readonly connectionId: string) {
    super(`integration connection ${connectionId} was not found`);
    this.name = 'ConnectionNotFoundError';
  }
}

/** The provider answered with an OAuth `error` code. `code` is that JSON field, redacted and bounded. */
export class OauthVendorError extends Error {
  constructor(
    operation: string,
    readonly code: string,
    readonly description: string | null,
    readonly httpStatus: number,
  ) {
    super(`${operation} was refused by the provider (${code})`);
    this.name = 'OauthVendorError';
  }
}

/** No usable answer: the call failed or timed out, got a 5xx, or the body was not OAuth's. */
export class OauthUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OauthUnavailableError';
  }
}
