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
): {
  fetchFn: typeof fetch;
  pgSocket: ((options: PgSocketOptions) => net.Socket) | undefined;
} {
  if (role === 'admin') return { fetchFn: fetch, pgSocket: undefined };
  if (allowHosts === undefined || allowHosts.size === 0) {
    return { fetchFn: guardedFetch as typeof fetch, pgSocket: guardedPgSocket };
  }
  return {
    fetchFn: createGuardedFetch({ allowHosts }) as typeof fetch,
    pgSocket: createGuardedPgSocket({ allowHosts }),
  };
}
