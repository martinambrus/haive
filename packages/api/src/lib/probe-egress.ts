import type net from 'node:net';
import {
  createGuardedFetch,
  createGuardedPgSocket,
  guardedFetch,
  guardedPgSocket,
} from '@haive/shared/egress';

type PgSocketOptions = { host: string[]; port: number[]; path?: string | undefined };

export function egressFor(
  role: string | undefined,
  allowHosts?: ReadonlySet<string>,
  allowOrigins?: ReadonlySet<string>,
): {
  fetchFn: typeof fetch;
  pgSocket: ((options: PgSocketOptions) => Promise<net.Socket>) | undefined;
} {
  if (role === 'admin') return { fetchFn: fetch, pgSocket: undefined };
  if (!allowHosts?.size && !allowOrigins?.size) {
    return { fetchFn: guardedFetch as typeof fetch, pgSocket: guardedPgSocket };
  }
  return {
    fetchFn: createGuardedFetch({
      ...(allowHosts ? { allowHosts } : {}),
      ...(allowOrigins ? { allowOrigins } : {}),
    }) as typeof fetch,
    pgSocket: createGuardedPgSocket(allowHosts ? { allowHosts } : {}),
  };
}
