import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { listResidentOllamaModels } from '../src/rag/embed.js';
import { releaseEmbedModelIfUnused, resolveTaskEmbedTarget } from '../src/rag/embed-residency.js';

const URL = 'http://ollama:11434';
const MODEL = 'qwen3-embedding:4b';

/** A fetch stub that branches on path: `/api/ps` returns the given resident set
 *  (or throws when `psThrows`), `/api/embed` records the unload + returns ok. */
function stubFetch(opts: { resident?: string[]; psThrows?: boolean }) {
  const calls = { unload: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith('/api/ps')) {
        if (opts.psThrows) throw new Error('connection refused');
        return {
          ok: true,
          json: async () => ({ models: (opts.resident ?? []).map((name) => ({ name })) }),
        } as unknown as Response;
      }
      if (u.endsWith('/api/embed')) {
        calls.unload += 1;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  return calls;
}

/** Minimal Database stand-in: a live-task list for the `select` scan, plus
 *  queued return values for the relational `query.*.findFirst` reads. */
function fakeDb(opts: {
  liveTaskIds?: string[];
  toolingReturns?: Array<unknown>;
  tasksReturns?: Array<unknown>;
}): Database {
  const tooling = [...(opts.toolingReturns ?? [])];
  const tasks = [...(opts.tasksReturns ?? [])];
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve((opts.liveTaskIds ?? []).map((id) => ({ id }))),
      }),
    }),
    query: {
      taskSteps: { findFirst: async () => tooling.shift() },
      tasks: { findFirst: async () => tasks.shift() },
    },
  } as unknown as Database;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listResidentOllamaModels', () => {
  it('returns deduped model identifiers from /api/ps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [{ name: MODEL, model: MODEL }, { name: 'other:1b' }] }),
      })) as unknown as typeof fetch,
    );
    expect(await listResidentOllamaModels(URL)).toEqual([MODEL, 'other:1b']);
  });

  it('returns null (not []) when Ollama is unreachable, distinguishing down from idle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('refused');
      }) as unknown as typeof fetch,
    );
    expect(await listResidentOllamaModels(URL)).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
    expect(await listResidentOllamaModels(URL)).toBeNull();
  });
});

describe('releaseEmbedModelIfUnused', () => {
  it('not_resident: model absent → never calls unload (avoids load-then-unload)', async () => {
    const calls = stubFetch({ resident: [] });
    const status = await releaseEmbedModelIfUnused(fakeDb({}), { url: URL, model: MODEL });
    expect(status).toBe('not_resident');
    expect(calls.unload).toBe(0);
  });

  it('unreachable: /api/ps fails → never calls unload', async () => {
    const calls = stubFetch({ psThrows: true });
    const status = await releaseEmbedModelIfUnused(fakeDb({}), { url: URL, model: MODEL });
    expect(status).toBe('unreachable');
    expect(calls.unload).toBe(0);
  });

  it('in_use via alsoInUse: resident but caller flags external use → no unload', async () => {
    const calls = stubFetch({ resident: [MODEL] });
    const status = await releaseEmbedModelIfUnused(fakeDb({}), {
      url: URL,
      model: MODEL,
      alsoInUse: true,
    });
    expect(status).toBe('in_use');
    expect(calls.unload).toBe(0);
  });

  it('in_use via live task: a non-terminal task resolves to the same model → no unload', async () => {
    const calls = stubFetch({ resident: [MODEL] });
    const db = fakeDb({
      liveTaskIds: ['t1'],
      toolingReturns: [{ output: { tooling: { ollamaUrl: URL, embeddingModel: MODEL } } }],
    });
    const status = await releaseEmbedModelIfUnused(db, { url: URL, model: MODEL });
    expect(status).toBe('in_use');
    expect(calls.unload).toBe(0);
  });

  it('unloaded: resident and no task uses it → sends keep_alive:0', async () => {
    const calls = stubFetch({ resident: [MODEL] });
    const status = await releaseEmbedModelIfUnused(fakeDb({ liveTaskIds: [] }), {
      url: URL,
      model: MODEL,
    });
    expect(status).toBe('unloaded');
    expect(calls.unload).toBe(1);
  });
});

describe('resolveTaskEmbedTarget', () => {
  it('returns the task own 04-tooling target without the onboarding fallback', async () => {
    const db = fakeDb({
      toolingReturns: [{ output: { tooling: { ollamaUrl: URL, embeddingModel: MODEL } } }],
    });
    expect(await resolveTaskEmbedTarget(db, 'task-1')).toEqual({ url: URL, model: MODEL });
  });

  it('falls back to the repo latest onboarding 04-tooling for a workflow task', async () => {
    const db = fakeDb({
      // 1st readTooling(taskId) → none; 2nd readTooling(onboardingId) → target
      toolingReturns: [null, { output: { tooling: { ollamaUrl: URL, embeddingModel: MODEL } } }],
      // tasks.findFirst: by-id → repositoryId; onboarding lookup → onboarding id
      tasksReturns: [{ repositoryId: 'r1' }, { id: 'onb' }],
    });
    expect(await resolveTaskEmbedTarget(db, 'wf-task')).toEqual({ url: URL, model: MODEL });
  });

  it('returns null when no Ollama model is configured (hash-fallback task)', async () => {
    const db = fakeDb({ toolingReturns: [null], tasksReturns: [{ repositoryId: null }] });
    expect(await resolveTaskEmbedTarget(db, 'task-x')).toBeNull();
  });
});
