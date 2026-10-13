import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  createTaskType,
  deleteTaskType,
  getAdminTaskType,
  getTaskTypeCatalog,
  listAdminTaskTypes,
  listTaskTypes,
  updateTaskType,
  type ApiError,
} from '../src/lib/api-client.js';

const failWith = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

const thrown = async (): Promise<ApiError> => {
  try {
    await api.post('/admin/task-types', {});
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('request did not fail');
};

describe('api error message', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never prints undefined for issues that carry no message, and keeps them on the body', async () => {
    const issues = [
      { kind: 'unmet-need', index: 0, stepId: 'a', needs: 'x', reason: 'needs x' },
      { kind: 'unknown-step', index: 1, stepId: 'b' },
    ];
    failWith(400, { error: 'Invalid step composition', issues });
    const err = await thrown();
    expect(err.message).toBe('Invalid step composition');
    expect(err.message).not.toContain('undefined');
    expect(err.status).toBe(400);
    expect((err.body as { issues: unknown }).issues).toEqual(issues);
  });

  it('still lists the path and message of a validation issue', async () => {
    failWith(400, {
      error: 'Validation failed',
      issues: [
        { path: 'slug', message: 'Invalid' },
        { path: '', message: 'Required' },
      ],
    });
    expect((await thrown()).message).toBe('Validation failed: slug — Invalid; (root) — Required');
  });

  it('lists only the issues that have a message when the kinds are mixed', async () => {
    failWith(400, {
      error: 'Mixed',
      issues: [{ kind: 'empty' }, { path: 'slug', message: 'Invalid' }],
    });
    expect((await thrown()).message).toBe('Mixed: slug — Invalid');
  });
});

describe('task type helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  const record = (status: number, body: unknown) => {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
        return new Response(status === 204 ? null : JSON.stringify(body), { status });
      }),
    );
    return calls;
  };

  it('reads through the list, detail, catalog and public routes', async () => {
    const calls = record(200, {});
    await listAdminTaskTypes();
    await getAdminTaskType('my type');
    await getTaskTypeCatalog();
    await listTaskTypes();
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/admin/task-types'],
      ['GET', '/admin/task-types/my%20type'],
      ['GET', '/admin/task-types/catalog'],
      ['GET', '/task-types'],
    ]);
  });

  it('writes through create, update and delete', async () => {
    const calls = record(200, {});
    const create = { slug: 'a-b', displayName: 'A', stepIds: ['x'], requiresRepository: false };
    await createTaskType(create);
    await updateTaskType('a-b', { displayName: 'B' });
    vi.unstubAllGlobals();
    const gone = record(204, null);
    await deleteTaskType('a-b');
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ['POST', '/admin/task-types', JSON.stringify(create)],
      ['PATCH', '/admin/task-types/a-b', JSON.stringify({ displayName: 'B' })],
    ]);
    expect(gone.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['DELETE', '/admin/task-types/a-b'],
    ]);
  });
});
