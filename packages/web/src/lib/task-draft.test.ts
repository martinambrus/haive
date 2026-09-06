import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readTaskDraft, stashTaskDraft, taskDraftHref } from './task-draft';

/** A minimal sessionStorage, since the node test env has none. */
function installStorage(over: Partial<Storage> = {}): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    ...over,
  });
  return store;
}

const draft = {
  title: 'Comms layer plus the two things on top',
  description: 'A long rationale that has no business in a query string.',
  planNodeIds: ['a', 'b'],
  planNodeRole: 'implements' as const,
  fromPlanChat: true as const,
};

describe('task draft stash', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('round-trips a draft through a token', () => {
    const token = stashTaskDraft(draft);
    expect(readTaskDraft(token)).toEqual(draft);
  });

  it('reads the same draft twice — StrictMode renders the component body again', () => {
    // A plainly destructive read hands the second pass null and the form comes
    // up blank in development only, which is the worst place to find it.
    const token = stashTaskDraft(draft);
    expect(readTaskDraft(token)).toEqual(draft);
    expect(readTaskDraft(token)).toEqual(draft);
  });

  it('takes the draft OUT of storage on the first read', () => {
    const store = installStorage();
    const token = stashTaskDraft(draft)!;
    readTaskDraft(token);
    expect([...store.keys()]).toEqual([]);
  });

  it('is null for an unknown, absent or malformed token', () => {
    expect(readTaskDraft(null)).toBeNull();
    expect(readTaskDraft('never-stashed')).toBeNull();
    const store = installStorage();
    store.set('haive.taskDraft.bad', '{not json');
    expect(readTaskDraft('bad')).toBeNull();
  });

  it('defaults a stored draft with no role to touched, never to greening nodes', () => {
    const store = installStorage();
    store.set('haive.taskDraft.t', JSON.stringify({ planNodeIds: ['a'] }));
    expect(readTaskDraft('t')?.planNodeRole).toBe('touched');
  });

  it('survives storage being unavailable', () => {
    // Private mode, or a browser set to block site data. The link must still
    // carry the node set even though the prose cannot travel.
    installStorage({
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(stashTaskDraft(draft)).toBeNull();
    const href = taskDraftHref('repo-1', draft);
    expect(href).toContain('planNodeIds=a%2Cb');
    expect(href).toContain('title=');
    expect(href).not.toContain('draft=');
  });
});

describe('taskDraftHref', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('carries the node set in the query AND the prose behind a token', () => {
    const href = taskDraftHref('repo-1', draft);
    expect(href).toContain('repositoryId=repo-1');
    expect(href).toContain('planNodeIds=a%2Cb');
    expect(href).toMatch(/draft=[a-z0-9-]+/);
    // The description is the reason a token exists at all.
    expect(href).not.toContain('no business in a query string');
  });
});
