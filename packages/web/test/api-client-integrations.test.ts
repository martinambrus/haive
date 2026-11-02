import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearIntegrationPreference,
  getRepositoryIntegrations,
  getTaskIntegrations,
  saveTaskIntegration,
  resetTaskIntegration,
  listAdminIntegrationDefaults,
  listIntegrationConnections,
  listIntegrationDefaults,
  listIntegrationPreferences,
  listIntegrationProviders,
  saveAdminIntegrationDefault,
  saveIntegrationPreference,
  saveRepositoryIntegrations,
} from '../src/lib/api-client.js';

const record = () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  return () =>
    calls.map((c) => [c.method, new URL(c.url).pathname + new URL(c.url).search, c.body]);
};

describe('integration choice helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the providers, connections, preferences and defaults', async () => {
    const sent = record();
    await listIntegrationProviders();
    await listIntegrationConnections();
    await listIntegrationPreferences();
    await listIntegrationDefaults();
    await listAdminIntegrationDefaults();
    expect(sent()).toEqual([
      ['GET', '/integrations/providers', undefined],
      ['GET', '/integrations/connections', undefined],
      ['GET', '/integrations/preferences', undefined],
      ['GET', '/integrations/defaults', undefined],
      ['GET', '/admin/integrations/defaults', undefined],
    ]);
  });

  it('saves a preference with exactly the body the route takes, and clears it with a DELETE', async () => {
    const sent = record();
    await saveIntegrationPreference('forge', { providerId: 'gitlab', connectionId: null });
    await saveIntegrationPreference('file-storage', {
      providerId: 'module.acme.docs',
      connectionId: 'c-1',
    });
    await clearIntegrationPreference('forge');
    expect(sent()).toEqual([
      [
        'PUT',
        '/integrations/preferences/forge',
        JSON.stringify({ providerId: 'gitlab', connectionId: null }),
      ],
      [
        'PUT',
        '/integrations/preferences/file-storage',
        JSON.stringify({ providerId: 'module.acme.docs', connectionId: 'c-1' }),
      ],
      ['DELETE', '/integrations/preferences/forge', undefined],
    ]);
  });

  it('saves an install default, and clears it with a null provider', async () => {
    const sent = record();
    await saveAdminIntegrationDefault('forge', 'github');
    await saveAdminIntegrationDefault('forge', null);
    expect(sent()).toEqual([
      ['PUT', '/admin/integrations/defaults/forge', JSON.stringify({ providerId: 'github' })],
      ['PUT', '/admin/integrations/defaults/forge', JSON.stringify({ providerId: null })],
    ]);
  });

  it('uses task PUT/DELETE with explicit remember only, preserving encoded route ids', async () => {
    const sent = record();
    await getTaskIntegrations('task 1');
    await saveTaskIntegration('task 1', 'module.acme.docs', {
      providerId: 'module.acme.docs',
      connectionId: 'account-2',
    });
    await saveTaskIntegration('task 1', 'forge', {
      providerId: 'gitlab',
      connectionId: null,
      remember: true,
    });
    await resetTaskIntegration('task 1', 'module.acme.docs');
    await resetTaskIntegration('task 1', 'forge', true);
    expect(sent()).toEqual([
      ['GET', '/tasks/task%201/integrations', undefined],
      [
        'PUT',
        '/tasks/task%201/integrations/module.acme.docs',
        JSON.stringify({ providerId: 'module.acme.docs', connectionId: 'account-2' }),
      ],
      [
        'PUT',
        '/tasks/task%201/integrations/forge',
        JSON.stringify({ providerId: 'gitlab', connectionId: null, remember: true }),
      ],
      ['DELETE', '/tasks/task%201/integrations/module.acme.docs', undefined],
      ['DELETE', '/tasks/task%201/integrations/forge?remember=1', undefined],
    ]);
  });

  it('reads and saves a repository allow-list under that repository', async () => {
    const sent = record();
    await getRepositoryIntegrations('repo 1');
    await saveRepositoryIntegrations('repo 1', { restricted: true, connectionIds: ['c-1', 'c-2'] });
    expect(sent()).toEqual([
      ['GET', '/repositories/repo%201/integrations', undefined],
      [
        'PUT',
        '/repositories/repo%201/integrations',
        JSON.stringify({ restricted: true, connectionIds: ['c-1', 'c-2'] }),
      ],
    ]);
  });
});
