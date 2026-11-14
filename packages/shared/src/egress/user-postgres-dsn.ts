type RefusedParameter = 'sslrootcert' | 'sslcert' | 'sslkey' | 'host';

export class UserPostgresDsnError extends Error {
  constructor(readonly parameter: RefusedParameter) {
    super(`PostgreSQL connection parameter "${parameter}" is not allowed`);
    this.name = 'UserPostgresDsnError';
  }
}

/** Reject local resources before postgres.js parses a user/repository DSN. Do not
 * strip parameters: that would silently change the requested TLS policy.
 * Keep this tail/authority split aligned with postgres.js parseUrl, which accepts
 * multi-host authorities and unescaped @ in passwords that WHATWG URL rejects. */
export function assertUserPostgresDsn(dsn: string): void {
  const rest = dsn.slice(dsn.indexOf('://') + 3);
  const end = rest.search(/[/?]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  let tail: URL;
  try {
    tail = new URL('postgres://x' + (end === -1 ? '' : rest.slice(end)));
  } catch {
    throw new Error('Invalid PostgreSQL connection string');
  }
  for (const parameter of ['sslrootcert', 'sslcert', 'sslkey'] as const) {
    // Presence matters even for empty, duplicated, or "system" values.
    if (tail.searchParams.has(parameter)) throw new UserPostgresDsnError(parameter);
  }
  // The driver's query reduction keeps the last value. Query hosts are already
  // URL-decoded; authority hosts get one forgiving decode in parseUrl.
  const queryHosts = tail.searchParams.getAll('host');
  const queryHost = queryHosts.at(-1);
  let host = authority.slice(authority.lastIndexOf('@') + 1);
  if (queryHost) {
    host = queryHost;
  } else {
    // Match the driver's decode per comma-separated target, including malformed
    // escapes in one target alongside a valid encoded slash in another.
    host = host
      .split(',')
      .map((target) => {
        try {
          return decodeURIComponent(target);
        } catch {
          return target;
        }
      })
      .join(',');
  }
  if (host.includes('/')) throw new UserPostgresDsnError('host');
}
