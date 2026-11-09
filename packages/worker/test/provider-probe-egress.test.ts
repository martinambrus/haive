import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { BaseCliAdapter } from '../src/cli-adapters/base-adapter.js';

vi.mock('../src/queues/cli-exec/exec-core.js', () => ({
  createSandboxSpawner: () => async () => ({
    exitCode: 0,
    stdout: '2.0.0 (Claude Code)',
    stderr: '',
  }),
}));
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: () => ({ tag: 'probe-test' }),
}));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { inspect: async () => ({ exists: true }) },
}));
vi.mock('../src/queues/cli-exec/handlers.js', () => ({
  handleBuildSandboxImageJob: async () => ({ ok: true, imageTag: 'unused' }),
}));

import { configService } from '@haive/shared/config';
import { OPENROUTER_COMPAT_PROXY_URL } from '../src/cli-adapters/openrouter-proxy.js';
import {
  OLLAMA_CLOUD_URL,
  OLLAMA_THINKING_PROXY_URL,
} from '../src/cli-adapters/ollama-thinking-proxy.js';
import { IN_STACK_OLLAMA_URL } from '@haive/shared';

const { probeCliPath } = await import('../src/queues/cli-exec/images.js');
const adapter = { defaultExecutable: 'claude' } as BaseCliAdapter;
const findOwner = vi.fn<() => Promise<{ role: string } | undefined>>();
const db = { query: { users: { findFirst: findOwner } } } as unknown as Database;
const globalFetch = vi.fn<typeof fetch>();
const sentinel = 'internal-service-reply-sentinel';
const body = JSON.stringify({ error: { message: sentinel } });

function provider(
  name: 'ollama' | 'openrouter',
  overrides: Partial<CliProviderRecord> = {},
): CliProviderRecord {
  return {
    id: 'provider-1',
    userId: 'owner-1',
    name,
    model: 'test-model',
    envVars: { ANTHROPIC_BASE_URL: 'http://10.23.45.67:8123' },
    authMode: 'api_key',
    disableThinking: false,
    ...overrides,
  } as CliProviderRecord;
}

const probe = (p: CliProviderRecord, secrets: Record<string, string> = {}) =>
  probeCliPath(db, adapter, p, { ANTHROPIC_AUTH_TOKEN: 'test-key', ...secrets });

// Exercise the real guarded fetch and its lookup; replace only the HTTP transport.
// No request in this suite can open a socket.
function httpReply(status = 200, responseBody = '{}', transportCode?: string) {
  const connected = vi.fn();
  vi.mocked(http.request).mockImplementation(((
    options: http.RequestOptions,
    receive: (res: http.IncomingMessage) => void,
  ) => {
    const request = new EventEmitter() as http.ClientRequest;
    request.destroy = vi.fn(() => request);
    request.end = vi.fn(() => {
      queueMicrotask(() => {
        const answer = () => {
          connected();
          if (transportCode) {
            request.emit(
              'error',
              Object.assign(new Error('transport unavailable'), { code: transportCode }),
            );
          } else {
            const response = Object.assign(Readable.from([responseBody]), {
              statusCode: status,
              statusMessage: '',
              headers: {},
            });
            receive(response as http.IncomingMessage);
          }
        };
        if (options.lookup && !net.isIP(String(options.hostname))) {
          options.lookup(String(options.hostname), {}, (err) => {
            if (err) request.emit('error', err);
            else answer();
          });
        } else answer();
      });
      return request;
    }) as http.ClientRequest['end'];
    return request;
  }) as typeof http.request);
  return connected;
}

beforeEach(() => {
  findOwner.mockReset().mockResolvedValue({ role: 'user' });
  globalFetch.mockReset().mockImplementation(async () => new Response(body, { status: 400 }));
  vi.stubGlobal('fetch', globalFetch);
  vi.spyOn(configService, 'get').mockResolvedValue(null);
  vi.spyOn(http, 'request').mockImplementation(() => {
    throw new Error('unexpected HTTP request');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider probe egress', () => {
  it.each(['ollama', 'openrouter'] as const)(
    'sanitizes a rejecting owner role lookup for %s without dialing',
    async (name) => {
      const query = 'select role from users where id = $1';
      const ownerId = provider(name).userId;
      findOwner.mockRejectedValue(new DrizzleQueryError(query, [ownerId], new Error('offline')));
      const result = await probe(provider(name));
      expect(result.ok).toBe(false);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
      expect(result.error).toBeTypeOf('string');
      expect(result.error).not.toContain(query);
      expect(result.error).not.toContain(ownerId);
    },
  );

  it.each(['ollama', 'openrouter'] as const)(
    'guards a non-admin hand-set %s private literal before connecting',
    async (name) => {
      const result = await probe(provider(name));
      expect(globalFetch).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
      expect(result.error ?? '').not.toContain(sentinel);
      expect(findOwner).toHaveBeenCalledExactlyOnceWith({
        where: eq(schema.users.id, 'owner-1'),
        columns: { role: true },
      });
    },
  );

  it.each(['ollama', 'openrouter'] as const)(
    'keeps plain fetch for an admin-owned %s provider',
    async (name) => {
      findOwner.mockResolvedValue({ role: 'admin' });
      const result = await probe(provider(name));
      expect(globalFetch).toHaveBeenCalledWith(
        'http://10.23.45.67:8123/v1/messages',
        expect.anything(),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain(sentinel);
      expect(http.request).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { role: 'administrator' }])(
    'guards a missing or non-admin owner: %j',
    async (owner) => {
      findOwner.mockResolvedValue(owner);
      await probe(provider('ollama'));
      expect(globalFetch).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['openrouter', 'test-model', false, OPENROUTER_COMPAT_PROXY_URL],
    ['ollama', 'local-model:4b', false, IN_STACK_OLLAMA_URL],
    ['ollama', 'model:cloud', false, OLLAMA_CLOUD_URL],
    ['ollama', 'model:cloud', true, OLLAMA_THINKING_PROXY_URL],
  ] as const)(
    'keeps platform-picked %s/%s/%s on plain fetch without a role lookup',
    async (name, model, disableThinking, url) => {
      globalFetch.mockImplementation(async () => new Response('{}'));
      const result = await probe(provider(name, { envVars: null, model, disableThinking }));
      expect(result.ok).toBe(true);
      expect(globalFetch).toHaveBeenCalledWith(url + '/v1/messages', expect.anything());
      expect(findOwner).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
    },
  );

  it('guards the merged secret base URL', async () => {
    await probe(provider('ollama', { envVars: null }), {
      ANTHROPIC_BASE_URL: 'http://10.23.45.67:8123',
    });
    expect(findOwner).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('treats an empty hand-set URL as explicit', async () => {
    await probe(provider('ollama', { envVars: { ANTHROPIC_BASE_URL: '' } }));
    expect(findOwner).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each(['http://ollama:11434', 'http://host.docker.internal:11434'])(
    'allows the built-in target %s through the guard',
    async (url) => {
      vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [
        { address: '172.20.0.8', family: 4 },
      ]) as unknown as typeof dns.promises.lookup);
      const connected = httpReply();
      const result = await probe(provider('ollama', { envVars: { ANTHROPIC_BASE_URL: url } }));
      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(connected).toHaveBeenCalledOnce();
      expect(globalFetch).not.toHaveBeenCalled();
      expect(configService.get).not.toHaveBeenCalled();
    },
  );

  it('lets the admin allowlist lift a hand-set private target', async () => {
    vi.mocked(configService.get).mockResolvedValue('10.23.45.67');
    const connected = httpReply();
    const result = await probe(provider('ollama'));
    expect(result.ok).toBe(true);
    expect(connected).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps a guarded public HTTP error a failure', async () => {
    const connected = httpReply(401, body);
    const result = await probe(
      provider('ollama', { envVars: { ANTHROPIC_BASE_URL: 'http://8.8.8.8' } }),
    );
    expect(connected).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 401');
    expect(result.warning).toBeUndefined();
  });

  it('keeps an OpenRouter refusal silent and inconclusive', async () => {
    const result = await probe(provider('openrouter'));
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('guarded Ollama probe warnings', () => {
  it('reports a refused private literal as a warning with the version detail', async () => {
    const result = await probe(provider('ollama'));
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('2.0.0 (Claude Code)');
    expect(result.warning).toContain('egress guard');
    expect(result.warning).toContain('or the name does not resolve');
    expect(result.error).toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('gives an unresolved name the same warning as a refused literal', async () => {
    const refused = await probe(provider('ollama'));
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(
      Object.assign(new Error('unknown name'), { code: 'ENOTFOUND' }),
    );
    const connected = httpReply();
    const unresolved = await probe(
      provider('ollama', { envVars: { ANTHROPIC_BASE_URL: 'http://ollama:11434' } }),
    );
    expect(connected).not.toHaveBeenCalled();
    expect(unresolved).toEqual({ ...refused, durationMs: unresolved.durationMs });
    expect(unresolved.ok).toBe(true);
    expect(unresolved.error).toBeUndefined();
  });

  it('gives a non-built-in unresolved name the same warning through c-ares', async () => {
    const refused = await probe(provider('ollama'));
    const notFound = Object.assign(new Error('unknown name'), { code: 'ENOTFOUND' });
    const resolve4 = vi
      .spyOn(dns.promises.Resolver.prototype, 'resolve4')
      .mockRejectedValue(notFound);
    const resolve6 = vi
      .spyOn(dns.promises.Resolver.prototype, 'resolve6')
      .mockRejectedValue(notFound);
    const systemLookup = vi.spyOn(dns.promises, 'lookup');
    const connected = httpReply();
    const unresolved = await probe(
      provider('ollama', { envVars: { ANTHROPIC_BASE_URL: 'http://unknown-provider.invalid' } }),
    );
    expect(resolve4).toHaveBeenCalledExactlyOnceWith('unknown-provider.invalid');
    expect(resolve6).toHaveBeenCalledExactlyOnceWith('unknown-provider.invalid');
    expect(systemLookup).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(unresolved).toEqual({ ...refused, durationMs: unresolved.durationMs });
  });

  it('keeps an admin ENOTFOUND as the existing failure', async () => {
    findOwner.mockResolvedValue({ role: 'admin' });
    globalFetch.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    const result = await probe(provider('ollama'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed (ENOTFOUND)');
    expect(result.warning).toBeUndefined();
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it('keeps platform-picked ENOTFOUND a failure', async () => {
    globalFetch.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    const result = await probe(provider('ollama', { envVars: null }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed (ENOTFOUND)');
    expect(result.warning).toBeUndefined();
    expect(findOwner).not.toHaveBeenCalled();
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT'])('keeps guarded %s a failure', async (code) => {
    httpReply(200, '{}', code);
    const result = await probe(
      provider('ollama', { envVars: { ANTHROPIC_BASE_URL: 'http://8.8.8.8' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(code);
    expect(result.warning).toBeUndefined();
  });

  it('does not turn an HTTP body mentioning ENOTFOUND into a warning', async () => {
    httpReply(502, JSON.stringify({ error: 'ENOTFOUND' }));
    const result = await probe(
      provider('ollama', { envVars: { ANTHROPIC_BASE_URL: 'http://8.8.8.8' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 502');
    expect(result.warning).toBeUndefined();
  });

  it('rechecks the owner role for every probe', async () => {
    const first = await probe(provider('ollama'));
    findOwner.mockResolvedValue({ role: 'admin' });
    const second = await probe(provider('ollama'));
    expect(first.ok).toBe(true);
    expect(first.warning).toBeDefined();
    expect(second.ok).toBe(false);
    expect(second.error).toContain(sentinel);
    expect(findOwner).toHaveBeenCalledTimes(2);
    expect(globalFetch).toHaveBeenCalledOnce();
  });
});
