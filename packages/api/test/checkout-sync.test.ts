import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';

const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (load) => ({
  ...(await load<typeof import('../src/queues.js')>()),
  getPlanMirrorQueue: () => ({ add: h.add }),
}));
vi.mock('../src/middleware/auth.js', async (load) => ({
  ...(await load<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    await next();
  },
}));
import { createApiApp } from '../src/index.js';

const app = createApiApp('http://localhost:3000');
const request = (
  method = 'POST',
  origin = 'http://localhost:3000',
  id = '00000000-0000-4000-8000-000000000002',
) => app.request(`/repos/${id}/sync-checkout`, { method, headers: { origin } });

beforeEach(() => {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    name: 'fixture',
    source: 'blank',
    id: '00000000-0000-4000-8000-000000000002',
    userId: '00000000-0000-4000-8000-000000000001',
    status: 'ready',
  });
  fake.insert(schema.repositories, {
    name: 'fixture',
    source: 'blank',
    id: '00000000-0000-4000-8000-000000000003',
    userId: '00000000-0000-4000-8000-000000000004',
    status: 'ready',
  });
  h.db = fake.db;
  h.add.mockReset().mockResolvedValue({ id: 'checkout-sync-00000000-0000-4000-8000-000000000002' });
  vi.spyOn(configService, 'get').mockResolvedValue(null);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
});

describe('checkout sync page hint', () => {
  it('queues a deduplicated hint through an authenticated POST', async () => {
    expect((await request()).status).toBe(202);
    expect(h.add).toHaveBeenCalledWith(
      'sync-checkout',
      {
        repositoryId: '00000000-0000-4000-8000-000000000002',
        userId: '00000000-0000-4000-8000-000000000001',
      },
      expect.objectContaining({
        jobId: 'checkout-sync-00000000-0000-4000-8000-000000000002',
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });
  it('does not enqueue through GET or a foreign page', async () => {
    expect((await request('GET')).status).toBe(404);
    expect((await request('POST', 'http://localhost:9000')).status).toBe(403);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('requires repository ownership', async () => {
    expect((await request('POST', undefined, '00000000-0000-4000-8000-000000000003')).status).toBe(
      404,
    );
    expect(h.add).not.toHaveBeenCalled();
  });
  it('honors the switch and lets reads continue when Redis is unavailable', async () => {
    vi.mocked(configService.getBoolean).mockResolvedValue(false);
    expect((await request()).status).toBe(202);
    expect(h.add).not.toHaveBeenCalled();
    vi.mocked(configService.getBoolean).mockResolvedValue(true);
    h.add.mockRejectedValue(new Error('fixture redis unavailable'));
    expect((await request()).status).toBe(202);
  });
});
