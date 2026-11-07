import dns from 'node:dns';
import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_PRIVATE_ORIGINS,
  DEFAULT_EXTERNAL_OLLAMA_URL,
  IN_STACK_OLLAMA_HOSTS,
} from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { egressFor } from '../src/lib/probe-egress.js';
import { probeEgressFor } from '../src/lib/probe-hosts.js';

describe('egressFor', () => {
  it('gives an admin the global fetch and no socket', () => {
    expect(egressFor('admin')).toEqual({ fetchFn: fetch, pgSocket: undefined });
  });

  it.each(['user', undefined])('guards role %s', (role) => {
    const { fetchFn, pgSocket } = egressFor(role);
    expect(fetchFn).not.toBe(fetch);
    expect(typeof pgSocket).toBe('function');
  });
});

describe('the shipped external Ollama default is built in', () => {
  async function dialsSystemResolver(fetchFn: typeof fetch) {
    // The lookup fails, so the dial never connects: port 11434 may answer on a developer machine.
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    try {
      await fetchFn(DEFAULT_EXTERNAL_OLLAMA_URL, { signal: AbortSignal.timeout(500) }).catch(
        () => undefined,
      );
      expect(lookup).toHaveBeenCalledWith('host.docker.internal', { all: true });
    } finally {
      lookup.mockRestore();
    }
  }

  it('egressFor passes the origin set to the guarded fetch', async () => {
    const { fetchFn } = egressFor('user', IN_STACK_OLLAMA_HOSTS, BUILT_IN_PRIVATE_ORIGINS);
    await dialsSystemResolver(fetchFn);
  });

  it('probeEgressFor wires the in-stack hosts and the built-in origins', async () => {
    const c = { get: (key: string) => (key === 'userRole' ? 'user' : undefined) };
    const { fetchFn } = await probeEgressFor(c as unknown as Context<AppEnv>);
    await dialsSystemResolver(fetchFn);
  });
});
