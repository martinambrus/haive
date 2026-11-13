import {
  createGuardedFetch,
  createGuardedPgSocket,
  guardedFetch,
  guardedPgSocket,
} from '@haive/shared/egress';

export function egressFor(
  role: string | undefined,
  allowHosts?: ReadonlySet<string>,
  allowOrigins?: ReadonlySet<string>,
): {
  fetchFn: typeof fetch;
  pgSocket: ReturnType<typeof createGuardedPgSocket> | undefined;
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
